import { NestFactory } from '@nestjs/core';
import { Injectable, Module, Controller, Post, Body, Get, Param, Put, Headers, HttpException, HttpStatus, CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import axios from 'axios';
import * as https from 'https';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { json, urlencoded } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
const speakeasy = require('speakeasy');
import * as qrcode from 'qrcode';
import { DbService } from './db.service';

const JWT_SECRET = 'PORAWAT_PAY_ENTERPRISE_SECRET_2026';

class TaskQueue {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;
  async add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await task()); } catch (e) { reject(e); }
      });
      this.process();
    });
  }
  private async process() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) await task();
    }
    this.isProcessing = false;
  }
}
const topupQueue = new TaskQueue();

function generateApiKey(tier: string) {
  const randomStr = crypto.randomBytes(24).toString('hex'); 
  return `prw_${tier.toLowerCase()}_${randomStr}`; 
}

@Controller('api')
class AppController {
  private readonly adminPhone = '0949806495'; // 🟢 เบอร์แอดมินสำหรับรับเงินเข้าระบบ

  constructor(private db: DbService) {}

  @Post('auth/register')
  async register(@Body() body: any) {
    const { username, firstName, lastName, phone, address, email, password, confirmPassword } = body;
    if (!password || password.length < 6) throw new HttpException({ success: false, message: 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร' }, HttpStatus.BAD_REQUEST);
    if (password !== confirmPassword) throw new HttpException({ success: false, message: 'ยืนยันรหัสผ่านไม่ตรงกัน' }, HttpStatus.BAD_REQUEST);

    const existingUser = await this.db.query('SELECT id FROM "User" WHERE username = $1', [username]);
    if (existingUser.length > 0) throw new HttpException({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' }, HttpStatus.BAD_REQUEST);

    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = generateApiKey('NONE');

    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const insertUserRes = await client.query(
        'INSERT INTO "User" (username, "firstName", "lastName", phone, address, email, password) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username',
        [username, firstName, lastName, phone, address, email || null, hashedPassword]
      );
      const newUserId = insertUserRes.rows[0].id;
      
      await client.query(
        'INSERT INTO "ApiKey" (key, tier, "expireAt", "userId") VALUES ($1, $2, $3, $4)',
        [apiKey, 'NONE', '2099-01-01T00:00:00Z', newUserId]
      );
      await client.query('COMMIT');
      return { success: true, user: { username: insertUserRes.rows[0].username } };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  @Post('auth/login')
  async login(@Body() body: any) {
    const users = await this.db.query('SELECT * FROM "User" WHERE username = $1', [body.username]);
    const user = users[0];
    if (!user || !(await bcrypt.compare(body.password, user.password))) throw new HttpException({ success: false, message: 'ชื่อผู้ใช้งาน หรือ รหัสผ่านไม่ถูกต้อง' }, HttpStatus.UNAUTHORIZED);

    if (user.isTwoFactorEnabled) {
      if (!body.token) return { success: true, require2FA: true };
      const isValid = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: body.token, window: 1 });
      if (!isValid) throw new HttpException({ success: false, message: 'รหัส 2FA ไม่ถูกต้อง' }, HttpStatus.UNAUTHORIZED);
    }

    const apiKeys = await this.db.query('SELECT * FROM "ApiKey" WHERE "userId" = $1', [user.id]);
    const jwtToken = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    return { success: true, user: { ...user, apiKeys }, token: jwtToken };
  }

  @Post('auth/reset-password')
  async resetPassword(@Body() body: { username: string, token: string, newPassword: string }) {
    const { username, token, newPassword } = body;
    if (!username || !token || !newPassword || newPassword.length < 6) throw new HttpException({ success: false, message: 'ข้อมูลไม่ครบ หรือรหัสผ่านสั้นไป' }, HttpStatus.BAD_REQUEST);

    const users = await this.db.query('SELECT * FROM "User" WHERE username = $1', [username]);
    const user = users[0];
    if (!user) throw new HttpException({ success: false, message: 'ไม่พบผู้ใช้งาน' }, HttpStatus.NOT_FOUND);
    if (!user.isTwoFactorEnabled) throw new HttpException({ success: false, message: 'บัญชีนี้ยังไม่ได้เปิด 2FA' }, HttpStatus.BAD_REQUEST);

    const isValid = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: token, window: 1 });
    if (!isValid) throw new HttpException({ success: false, message: 'รหัส 2FA จากแอปไม่ถูกต้อง' }, HttpStatus.UNAUTHORIZED);

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.db.query('UPDATE "User" SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
    return { success: true, message: 'รีเซ็ตรหัสผ่านสำเร็จ' };
  }

  @Get('user/:username')
  async getUser(@Param('username') username: string) {
    const users = await this.db.query('SELECT * FROM "User" WHERE username = $1', [username]);
    if(users.length === 0) return {};
    const apiKeys = await this.db.query('SELECT * FROM "ApiKey" WHERE "userId" = $1 ORDER BY "expireAt" DESC', [users[0].id]);
    return { ...users[0], apiKeys };
  }

  @Put('user/:username/wallet')
  async setWalletPhone(@Param('username') username: string, @Body() body: { walletPhone: string }) {
    if (!/^[0-9]{10}$/.test(body.walletPhone)) throw new HttpException({ success: false, message: 'เบอร์โทรศัพท์ไม่ถูกต้อง' }, HttpStatus.BAD_REQUEST);
    const res = await this.db.query('UPDATE "User" SET "walletPhone" = $1 WHERE username = $2 RETURNING id', [body.walletPhone, username]);
    if (res.length === 0) throw new HttpException('ไม่พบผู้ใช้งาน', HttpStatus.NOT_FOUND);
    return { success: true, walletPhone: body.walletPhone };
  }

  @Post('2fa/generate')
  async generate2FA(@Headers('x-api-key') apiKey: string) {
    const keys = await this.db.query('SELECT "userId" FROM "ApiKey" WHERE key = $1', [apiKey]);
    if(keys.length === 0) throw new HttpException({ success: false, message: 'API Key ไม่ถูกต้อง' }, HttpStatus.UNAUTHORIZED);
    const users = await this.db.query('SELECT * FROM "User" WHERE id = $1', [keys[0].userId]);
    const secret = speakeasy.generateSecret({ name: `PORAWAT.PAY (${users[0].username})` });
    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);
    return { success: true, secret: secret.base32, qrCodeUrl };
  }

  @Post('2fa/verify')
  async verify2FA(@Headers('x-api-key') apiKey: string, @Body() body: { token: string, secret: string }) {
    const keys = await this.db.query('SELECT "userId" FROM "ApiKey" WHERE key = $1', [apiKey]);
    if(keys.length === 0) throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    const isValid = speakeasy.totp.verify({ secret: body.secret, encoding: 'base32', token: body.token, window: 1 });
    if (!isValid) throw new HttpException({ success: false, message: 'รหัส 6 หลักไม่ถูกต้อง' }, HttpStatus.BAD_REQUEST);
    await this.db.query('UPDATE "User" SET "isTwoFactorEnabled" = true, "twoFactorSecret" = $1 WHERE id = $2', [body.secret, keys[0].userId]);
    return { success: true, message: 'เปิดใช้งาน 2FA สำเร็จ' };
  }

  @Post('topup')
  async topup(@Body() body: { username: string, link: string }) {
    return topupQueue.add(async () => {
      const users = await this.db.query('SELECT * FROM "User" WHERE username = $1', [body.username]);
      if (users.length === 0) throw new HttpException('ไม่พบผู้ใช้', HttpStatus.NOT_FOUND);
      const user = users[0];

      let vId = body.link.match(/[?&]v=([a-zA-Z0-9]+)/)?.[1] || body.link.split('/').pop() || '';
      try {
        const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
        const res = await axios.post(`https://gift.truemoney.com/campaign/vouchers/${vId}/redeem`, 
          { mobile: this.adminPhone, voucher_hash: vId }, 
          { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 12)', 'Content-Type': 'application/json' } }
        );
        if (res.data.status.code === 'SUCCESS') {
          const amount = parseFloat(res.data.data.my_ticket.amount_baht);
          const client = await this.db.pool.connect();
          try {
            await client.query('BEGIN');
            const updated = await client.query('UPDATE "User" SET balance = balance + $1 WHERE id = $2 RETURNING balance', [amount, user.id]);
            await client.query('INSERT INTO "Transaction" (type, amount, status, "userId") VALUES ($1, $2, $3, $4)', ['TOPUP_VOUCHER', amount, 'SUCCESS', user.id]);
            await client.query('COMMIT');
            return { success: true, amount, newBalance: updated.rows[0].balance };
          } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        }
        throw new Error(res.data.status.code);
      } catch (err: any) {
        const code = err.response?.data?.status?.code || err.message;
        let msg = 'ลิงก์ซองของขวัญไม่ถูกต้อง หรือถูกใช้ไปแล้ว';
        if (code === 'VOUCHER_EXPIRED') msg = 'ซองของขวัญนี้หมดอายุแล้ว ❌';
        else if (code === 'VOUCHER_NOT_FOUND') msg = 'ไม่พบซองนี้ในระบบ (ลิงก์ผิด) ❌';
        else if (code === 'VOUCHER_OUT_OF_STOCK') msg = 'ซองนี้ถูกรับไปหมดแล้ว ❌';
        else if (code === 'TARGET_USER_NOT_FOUND') msg = 'เบอร์แอดมินรับเงินไม่ถูกต้อง ⚠️';
        else if (code === 'CANNOT_GET_OWN_VOUCHER') msg = 'ไม่สามารถรับซองของตัวเองได้ ⚠️';
        else if (err.response?.status === 403 || err.response?.status === 401) msg = 'ถูกระบบป้องกัน (WAF) บล็อกชั่วคราว 🛡️';
        return { success: false, message: msg };
      }
    });
  }

  // 🎁 API Gateway - รับซอง (Voucher Only)
  @Post('redeem')
  async gatewayRedeem(@Body() body: { link: string }, @Headers('x-api-key') apiKey: string) {
    const keys = await this.db.query('SELECT "userId", "usedQuota" FROM "ApiKey" WHERE key = $1 AND tier != \'NONE\' AND "expireAt" > NOW()', [apiKey]);
    if (keys.length === 0) throw new HttpException('API Key ผิดหรือหมดอายุ', HttpStatus.BAD_REQUEST);

    const users = await this.db.query('SELECT * FROM "User" WHERE id = $1', [keys[0].userId]);
    const user = users[0];
    if (!user || !user.walletPhone) throw new HttpException('API Key ผิดหรือยังไม่ผูกเบอร์รับเงิน', HttpStatus.BAD_REQUEST);

    let vId = body.link.match(/[?&]v=([a-zA-Z0-9]+)/)?.[1] || '';
    try {
      const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
      const res = await axios.post(`https://gift.truemoney.com/campaign/vouchers/${vId}/redeem`, 
        { mobile: user.walletPhone, voucher_hash: vId }, 
        { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 12)', 'Content-Type': 'application/json' } }
      );
      if (res.data.status.code === 'SUCCESS') {
        const amount = parseFloat(res.data.data.my_ticket.amount_baht);
        const client = await this.db.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('UPDATE "ApiKey" SET "usedQuota" = "usedQuota" + 1 WHERE key = $1', [apiKey]);
          await client.query('INSERT INTO "Transaction" (type, amount, status, "userId") VALUES ($1, $2, $3, $4)', ['API_REDEEM', amount, 'SUCCESS', user.id]);
          await client.query('COMMIT');
          return { success: true, amount, message: 'รับเงินเข้าเบอร์สำเร็จ' };
        } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }
      throw new Error(res.data.status.code);
    } catch (err: any) {
      const code = err.response?.data?.status?.code || err.message;
      let msg = 'รับเงินไม่สำเร็จ (ลิงก์ผิดพลาด)';
      if (code === 'VOUCHER_EXPIRED') msg = 'ซองของขวัญนี้หมดอายุแล้ว ❌';
      else if (code === 'VOUCHER_NOT_FOUND') msg = 'ไม่พบซองนี้ในระบบ (ลิงก์ผิด) ❌';
      else if (code === 'VOUCHER_OUT_OF_STOCK') msg = 'ซองนี้ถูกรับไปหมดแล้ว ❌';
      else if (code === 'TARGET_USER_NOT_FOUND') msg = 'เบอร์รับเงินของลูกค้าไม่ถูกต้อง ⚠️';
      else if (code === 'CANNOT_GET_OWN_VOUCHER') msg = 'ไม่สามารถรับซองของตัวเองได้ ⚠️';
      else if (err.response?.status === 403 || err.response?.status === 401) msg = 'ถูกระบบป้องกัน (WAF) บล็อกชั่วคราว 🛡️';
      return { success: false, message: msg };
    }
  }

  @Post('buy')
  async buyPackage(@Body() body: { username: string, price: number, tier: string }) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const users = await client.query('SELECT * FROM "User" WHERE username = $1', [body.username]);
      if(users.rows.length === 0) throw new HttpException({ success: false, message: 'ไม่พบผู้ใช้งาน' }, HttpStatus.NOT_FOUND);
      const user = users.rows[0];

      // 🟢 เหลือแต่แพ็กเกจ Voucher อย่างเดียว
      const packages: Record<string, { price: number, days: number }> = {
        'VOUCHER_STARTER': { price: 99, days: 30 }, 
        'VOUCHER_PRO': { price: 299, days: 30 }, 
        'VOUCHER_ENTERPRISE': { price: 699, days: 30 }
      };
      
      const selectedPkg = packages[body.tier];
      if (!selectedPkg || body.price !== selectedPkg.price) throw new Error('ข้อมูลแพ็กเกจไม่ถูกต้อง');
      if (user.balance < body.price) return { success: false, message: 'ยอดเงินไม่เพียงพอ กรุณาเติมเครดิต' };
      
      const updatedUser = await client.query('UPDATE "User" SET balance = balance - $1 WHERE id = $2 RETURNING balance', [body.price, user.id]);

      const keys = await client.query('SELECT * FROM "ApiKey" WHERE "userId" = $1 AND tier = $2', [user.id, body.tier]);
      if (keys.rows.length > 0) {
        const existingKey = keys.rows[0];
        let currentExpire = new Date(existingKey.expireAt);
        if (currentExpire.getTime() < Date.now()) currentExpire = new Date();
        currentExpire.setDate(currentExpire.getDate() + selectedPkg.days);
        await client.query('UPDATE "ApiKey" SET "expireAt" = $1, "usedQuota" = 0 WHERE id = $2', [currentExpire.toISOString(), existingKey.id]);
      } else {
        const expireDate = new Date(); expireDate.setDate(expireDate.getDate() + selectedPkg.days);
        await client.query('INSERT INTO "ApiKey" (key, tier, "expireAt", "userId") VALUES ($1, $2, $3, $4)', [generateApiKey(body.tier), body.tier, expireDate.toISOString(), user.id]);
      }
      await client.query('INSERT INTO "Transaction" (type, amount, status, "userId") VALUES ($1, $2, $3, $4)', [`BUY_${body.tier}`, -body.price, 'SUCCESS', user.id]);
      await client.query('COMMIT');
      return { success: true, newBalance: updatedUser.rows[0].balance };
    } catch(e) {
      await client.query('ROLLBACK');
      if (e instanceof HttpException) throw e;
      return { success: false, message: (e as any).message || 'เกิดข้อผิดพลาด' };
    } finally { client.release(); }
  }

  // 👑 Admin Panel (ลบเมนูตั้งค่าบัญชีธนาคารออกไปแล้ว)
  @Get('admin/stats')
  async getAdminStats(@Headers('x-api-key') apiKey: string) {
    const keys = await this.db.query('SELECT "userId" FROM "ApiKey" WHERE key = $1', [apiKey]);
    if(keys.length === 0) throw new HttpException('ปฏิเสธการเข้าถึง', HttpStatus.FORBIDDEN);
    const admins = await this.db.query('SELECT role FROM "User" WHERE id = $1 AND role = \'ADMIN\'', [keys[0].userId]);
    if(admins.length === 0) throw new HttpException('ปฏิเสธการเข้าถึง', HttpStatus.FORBIDDEN);

    const users = await this.db.query('SELECT id, username, "firstName", "lastName", role, balance, "isTwoFactorEnabled" FROM "User" ORDER BY id DESC');
    const transactions = await this.db.query('SELECT * FROM "Transaction" ORDER BY date DESC LIMIT 100');
    const sumRes = await this.db.query('SELECT SUM(balance) as total FROM "User"');

    return { success: true, users, transactions, totalSystemMoney: sumRes[0].total || 0 };
  }

  @Put('admin/user/:username')
  async updateAdminUser(@Param('username') targetUsername: string, @Body() body: { balance: number, role: string }, @Headers('x-api-key') apiKey: string) {
    const keys = await this.db.query('SELECT "userId" FROM "ApiKey" WHERE key = $1', [apiKey]);
    if(keys.length === 0) throw new HttpException('ปฏิเสธการเข้าถึง', HttpStatus.FORBIDDEN);
    const admins = await this.db.query('SELECT role FROM "User" WHERE id = $1 AND role = \'ADMIN\'', [keys[0].userId]);
    if(admins.length === 0) throw new HttpException('ปฏิเสธการเข้าถึง', HttpStatus.FORBIDDEN);

    const res = await this.db.query('UPDATE "User" SET balance = $1, role = $2 WHERE username = $3 RETURNING *', [parseFloat(body.balance as any), body.role, targetUsername]);
    if (res.length === 0) throw new HttpException('ไม่พบผู้ใช้งาน', HttpStatus.NOT_FOUND);
    return { success: true, user: res[0] };
  }
}

@Injectable()
class ApiLoggingInterceptor implements NestInterceptor {
  constructor(private db: DbService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const startTime = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        this.db.query(
          'INSERT INTO "ApiLog" (ip, method, endpoint, status, duration) VALUES ($1, $2, $3, $4, $5)',
          [req.ip || req.connection?.remoteAddress || 'Unknown', req.method, req.originalUrl, res.statusCode, duration]
        ).catch(err => console.error('Log Error:', err));
      }),
    );
  }
}

@Module({ controllers: [AppController], providers: [DbService, ApiLoggingInterceptor] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
    app.getHttpAdapter().getInstance().set('trust proxy', true);
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  app.use(rateLimit({ 
    windowMs: 1 * 60 * 1000, 
    max: 5, 
    keyGenerator: (req: any) => {
      // ดึง IP จริงๆ ของลูกค้าจาก Header ที่ Cloud ส่งมาให้
      return req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
    },
    message: { success: false, message: 'คุณเรียกใช้งาน API ถี่เกินไป กรุณารอสักครู่' } 
  }));

  const dbService = app.get(DbService);
  app.useGlobalInterceptors(new ApiLoggingInterceptor(dbService));

    // เปลี่ยนจาก await app.listen(3001); เป็นโค้ดนี้ครับ
  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 PORAWAT.PAY ONLINE on port ${port}!`);
}
bootstrap();
