const { Client } = require('pg');

const client = new Client({
  // 🟢 วางลิงก์ Neon ของคุณตรงนี้!
  connectionString: 'postgresql://neondb_owner:npg_mhyjrDuPF6b1@ep-long-morning-anash33q-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
});

async function setupDb() {
  await client.connect();
  console.log('⏳ กำลังเชื่อมต่อ Neon Cloud Database เพื่อสร้างตาราง...');

  const sql = `
    CREATE TABLE IF NOT EXISTS "User" (
      "id" SERIAL PRIMARY KEY, "username" TEXT NOT NULL UNIQUE, "firstName" TEXT NOT NULL, "lastName" TEXT NOT NULL,
      "phone" TEXT NOT NULL, "address" TEXT NOT NULL, "email" TEXT, "password" TEXT NOT NULL, "walletPhone" TEXT,
      "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0, "role" TEXT NOT NULL DEFAULT 'USER', "isTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
      "twoFactorSecret" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS "ApiKey" (
      "id" SERIAL PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "tier" TEXT NOT NULL, "expireAt" TIMESTAMP(3) NOT NULL,
      "usedQuota" INTEGER NOT NULL DEFAULT 0, "userId" INTEGER NOT NULL,
      CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "Transaction" (
      "id" SERIAL PRIMARY KEY, "type" TEXT NOT NULL, "amount" DOUBLE PRECISION NOT NULL, "status" TEXT NOT NULL,
      "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "userId" INTEGER NOT NULL,
      CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "ApiLog" (
      "id" SERIAL PRIMARY KEY, "ip" TEXT, "method" TEXT NOT NULL, "endpoint" TEXT NOT NULL, "status" INTEGER NOT NULL, "duration" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS "BankAccount" (
      "id" SERIAL PRIMARY KEY, "bankCode" INTEGER NOT NULL, "bankName" TEXT NOT NULL, "accountNumber" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "TopupSlip" (
      "id" SERIAL PRIMARY KEY, "amountDetected" DOUBLE PRECISION NOT NULL, "transactionRef" TEXT NOT NULL UNIQUE,
      "status" TEXT NOT NULL, "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "slipImagePath" TEXT,
      "ocrResponse" JSONB, "userId" INTEGER NOT NULL,
      CONSTRAINT "TopupSlip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
    );
  `;

  try {
    await client.query(sql);
    console.log('✅ สร้างตารางทั้งหมดบน Neon สำเร็จแล้ว!');
  } catch (err) { console.error('❌ ข้อผิดพลาด:', err); } finally { await client.end(); }
}

setupDb();
