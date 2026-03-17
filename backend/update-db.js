const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://porawat:123456@localhost:5432/porawatpay?schema=public'
});

async function updateDb() {
  await client.connect();
  console.log('⏳ กำลังเชื่อมต่อเพื่อสร้างตารางบัญชีธนาคาร...');

  const sql = `
    CREATE TABLE IF NOT EXISTS "BankAccount" (
      "id" SERIAL PRIMARY KEY,
      "bankCode" INTEGER NOT NULL,
      "bankName" TEXT NOT NULL,
      "accountNumber" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "TopupSlip" (
      "id" SERIAL PRIMARY KEY,
      "amountDetected" DOUBLE PRECISION NOT NULL,
      "transactionRef" TEXT NOT NULL UNIQUE,
      "status" TEXT NOT NULL,
      "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "slipImagePath" TEXT,
      "ocrResponse" JSONB,
      "userId" INTEGER NOT NULL,
      CONSTRAINT "TopupSlip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
    );
  `;

  try {
    await client.query(sql);
    console.log('✅ สร้างตารางบัญชีธนาคาร และ สลิป สำเร็จแล้ว!');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err);
  } finally {
    await client.end();
  }
}

updateDb();
