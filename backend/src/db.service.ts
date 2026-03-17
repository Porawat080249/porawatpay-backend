import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  public pool: Pool;

  constructor() {
    this.pool = new Pool({
      // 🟢 วางลิงก์ Neon ของคุณตรงนี้!
      connectionString: 'postgresql://neondb_owner:npg_mhyjrDuPF6b1@ep-long-morning-anash33q-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      
      // 🟢 ตั้งค่าให้ทนทานต่อ Cloud Database มากขึ้น
      connectionTimeoutMillis: 5000, 
      idleTimeoutMillis: 30000,
    });

    // 🟢 1. ดักจับ Error เวลา Neon ตัดการเชื่อมต่อที่ไม่ได้ใช้งาน (แอปจะได้ไม่แครช)
    this.pool.on('error', (err) => {
      console.error('⚠️ Neon Database Connection Dropped (ระบบจะต่อใหม่ให้อัตโนมัติ):', err.message);
    });
  }

  async onModuleInit() {
    try {
      // 🟢 2. ดึง Connection มาเทส
      const client = await this.pool.connect();
      console.log('☁️ Neon Cloud Database Connected Successfully!');
      // 🟢 3. เทสเสร็จ ต้องปล่อยคืน Pool ทันที!
      client.release(); 
    } catch (err) {
      console.error('❌ Database Connection Error:', err.message);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query(sql: string, params?: any[]) {
    // ใช้ Pool ยิง Query โดยตรง ระบบจะจัดการเรื่องเชื่อมต่อให้เอง
    const result = await this.pool.query(sql, params);
    return result.rows;
  }
}
