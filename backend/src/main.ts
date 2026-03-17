import { NestFactory } from '@nestjs/core';
import { 
  Injectable, Module, Controller, Post, Body, Get, Param, Put, Headers, 
  UnauthorizedException, HttpException, HttpStatus, CallHandler, 
  ExecutionContext, NestInterceptor 
} from '@nestjs/common';
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

// 🛡️ ดึงรหัสลับจาก Environment Variable
const JWT_SECRET = process.env.JWT_SECRET || 'Porawat_Pay_Private_Key_2026!';

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
  private readonly adminPhone = '0949806495';

  constructor(private readonly dbService: DbService) {} 

  @Post('auth/register')
  async register(@Body() body: any) {
    const { username, firstName, lastName, phone, address, email, password, confirmPassword } = body;
    if (!password || password.length < 6) throw new HttpException({ success: false, message: 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร' }, HttpStatus.BAD_REQUEST);
    if (password !== confirmPassword) throw new HttpException({ success: false, message: 'ยืนยันรหัสผ่านไม่ตรงกัน' }, HttpStatus.BAD_REQUEST);

    const existingUser = await this.dbService.query('SELECT id FROM "User" WHERE username = $1', [username]);
    if (existingUser.length > 0) throw new HttpException({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' }, HttpStatus.BAD_REQUEST);

    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = generateApiKey('NONE');

    const client = await this.dbService.pool.connect();
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
    const users = await this.dbService.query('SELECT * FROM "User" WHERE username = $1', [body.username]);
    const user = users[0];
    if (!user || !(await bcrypt.compare(body.password, user.password))) throw new HttpException({ success: false, message: 'ชื่อผู้ใช้งาน หรือ รหัสผ่านไม่ถูกต้อง' }, HttpStatus.UNAUTHORIZED);

    if (user.isTwoFactorEnabled) {
      if (!body.token) return { success: true, require2FA: true };
      const isValid = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: body.token, window: 1 });
      if (!isValid) throw new HttpException({ success: false, message: 'รหัส 2FA ไม่ถูกต้อง' }, HttpStatus.UNAUTHORIZED);
    }

    const apiKeys = await this.dbService.query('SELECT * FROM "ApiKey" WHERE "userId" = $1', [user.id]);
    const jwtToken = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    return { success: true, user: { ...user, apiKeys }, token: jwtToken };
  }

  @Get('user/:username')
  async getUserProfile(@Param('username') username: string, @Headers('authorization') authHeader: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Access Denied: Missing Token');
    }
    const token = authHeader.split(' ')[1];
    try {
      jwt.verify(token, JWT_SECRET); 
    } catch (err) {
      throw new UnauthorizedException('Access Denied: Invalid Token');
    }
    const result = await this.dbService.query('SELECT id, username, "firstName", "lastName", phone, address, email, balance, role, "walletPhone" FROM "User" WHERE username = $1', [username]);
    if (result.length === 0) throw new HttpException('User Not Found', HttpStatus.NOT_FOUND);
    return { success: true, user: result[0] };
  }

  @Put('user/:username/wallet')
  async setWalletPhone(@Param('username') username: string, @Body() body: { walletPhone: string }) {
    if (!/^[0-9]{10}$/.test(body.walletPhone)) throw new HttpException({ success: false, message: 'เบอร์โทรศัพท์ไม่ถูกต้อง' }, HttpStatus.BAD_REQUEST);
    const res = await this.dbService.query('UPDATE "User" SET "walletPhone" = $1 WHERE username = $2 RETURNING id', [body.walletPhone, username]);
    if (res.length === 0) throw new HttpException('ไม่พบผู้ใช้งาน', HttpStatus.NOT_FOUND);
    return { success: true, walletPhone: body.walletPhone };
  }

  @Post('2fa/generate')
  async generate2FA(@Headers('x-api-key') apiKey: string) {
    const keys = await this.dbService.query('SELECT "userId" FROM "ApiKey" WHERE key = $1', [apiKey]);
    if(keys.length === 0) throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    const users = await this.dbService.query('SELECT * FROM "User" WHERE id = $1', [keys[0].userId]);
    const secret = speakeasy.generateSecret({ name: `PORAWAT.PAY (${users[0].username})` });
    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);
    return { success: true, secret: secret.base32, qrCodeUrl };
  }

  @Post('topup')
  async topup(@Body() body: { username: string, link: string }) {
    return topupQueue.add(async () => {
      const users = await this.dbService.query('SELECT * FROM "User" WHERE username = $1', [body.username]);
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
          const client = await this.dbService.pool.connect();
          try {
            await client.query('BEGIN');
            const updated = await client.query('UPDATE "User" SET balance = balance + $1 WHERE id = $2 RETURNING balance', [amount, user.id]);
            await client.query('INSERT INTO "Transaction" (type, amount, status, "userId") VALUES ($1, $2, $3, $4)', ['TOPUP_VOUCHER', amount, 'SUCCESS', user.id]);
            await client.query('COMMIT');
            return { success: true, amount, newBalance: updated.rows[0].balance };
          } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        }
        throw new Error(res.data.status.code);
      } catch (err: any) { return { success: false, message: 'เติมเงินไม่สำเร็จ' }; }
    });
  }

  @Post('redeem')
  async gatewayRedeem(@Body() body: { link: string }, @Headers('x-api-key') apiKey: string) {
    const keys = await this.dbService.query('SELECT "userId" FROM "ApiKey" WHERE key = $1 AND "expireAt" > NOW()', [apiKey]);
    if (keys.length === 0) throw new HttpException('API Key Invalid', HttpStatus.BAD_REQUEST);
    const users = await this.dbService.query('SELECT * FROM "User" WHERE id = $1', [keys[0].userId]);
    const user = users[0];
    if (!user || !user.walletPhone) throw new HttpException('Wallet not linked', HttpStatus.BAD_REQUEST);
    let vId = body.link.match(/[?&]v=([a-zA-Z0-9]+)/)?.[1] || '';
    try {
      const res = await axios.post(`https://gift.truemoney.com/campaign/vouchers/${vId}/redeem`, 
        { mobile: user.walletPhone, voucher_hash: vId }, 
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (res.data.status.code === 'SUCCESS') {
        const amount = parseFloat(res.data.data.my_ticket.amount_baht);
        await this.dbService.query('UPDATE "ApiKey" SET "usedQuota" = "usedQuota" + 1 WHERE key = $1', [apiKey]);
        return { success: true, amount };
      }
      throw new Error(res.data.status.code);
    } catch (e) { return { success: false, message: 'Redeem Failed' }; }
  }

  @Post('buy')
  async buyPackage(@Body() body: { username: string, price: number, tier: string }) {
    const client = await this.dbService.pool.connect();
    try {
      await client.query('BEGIN');
      const users = await client.query('SELECT * FROM "User" WHERE username = $1', [body.username]);
      const user = users.rows[0];
      if (user.balance < body.price) throw new Error('Insufficient Balance');
      await client.query('UPDATE "User" SET balance = balance - $1 WHERE id = $2', [body.price, user.id]);
      const expireDate = new Date(); expireDate.setDate(expireDate.getDate() + 30);
      await client.query('INSERT INTO "ApiKey" (key, tier, "expireAt", "userId") VALUES ($1, $2, $3, $4)', [generateApiKey(body.tier), body.tier, expireDate.toISOString(), user.id]);
      await client.query('COMMIT');
      return { success: true };
    } catch(e) { await client.query('ROLLBACK'); return { success: false, message: 'Buy Failed' }; } finally { client.release(); }
  }

  @Get('admin/stats')
  async getAdminStats(@Headers('x-api-key') apiKey: string) {
    const keys = await this.dbService.query('SELECT "userId" FROM "ApiKey" WHERE key = $1', [apiKey]);
    if(keys.length === 0) throw new UnauthorizedException();
    const users = await this.dbService.query('SELECT id, username, "firstName", "lastName", role, balance FROM "User" ORDER BY id DESC');
    const sumRes = await this.dbService.query('SELECT SUM(balance) as total FROM "User"');
    return { success: true, users, totalSystemMoney: sumRes[0].total || 0 };
  }

  @Put('admin/user/:username')
  async updateAdminUser(@Param('username') target: string, @Body() body: any, @Headers('x-api-key') apiKey: string) {
    await this.dbService.query('UPDATE "User" SET balance = $1, role = $2 WHERE username = $3', [body.balance, body.role, target]);
    return { success: true };
  }
}

@Injectable()
class ApiLoggingInterceptor implements NestInterceptor {
  constructor(private db: DbService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const startTime = Date.now();
    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        this.db.query('INSERT INTO "ApiLog" (ip, method, endpoint, duration) VALUES ($1, $2, $3, $4)', 
        [req.ip || 'Unknown', req.method, req.originalUrl, duration]).catch(() => {});
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
  app.use(rateLimit({ windowMs: 1 * 60 * 1000, max: 150 }));
  
  const dbService = app.get(DbService);
  app.useGlobalInterceptors(new ApiLoggingInterceptor(dbService));
  
  await app.listen(process.env.PORT || 3001, '0.0.0.0');
}
bootstrap();
