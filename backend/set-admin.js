const { Client } = require('pg');

const targetUsername = process.argv[2];

if (!targetUsername) {
  console.log('❌ กรุณาระบุชื่อผู้ใช้ด้วยครับ!\n💡 วิธีใช้: node set-admin.js <ชื่อผู้ใช้>');
  process.exit(1);
}

const client = new Client({
  // 🟢 เปลี่ยนตรงนี้ให้เป็นลิงก์ Neon ของคุณครับ!
  connectionString: 'postgresql://neondb_owner:npg_mhyjrDuPF6b1@ep-long-morning-anash33q-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
});

async function makeAdmin() {
  await client.connect();
  console.log(`⏳ กำลังเชื่อมต่อ Neon Cloud เพื่อปรับสิทธิ์ให้บัญชี: ${targetUsername}...`);

  try {
    const res = await client.query(
      'UPDATE "User" SET role = $1 WHERE username = $2 RETURNING username, role',
      ['ADMIN', targetUsername]
    );

    if (res.rowCount === 0) {
      console.log(`❌ ไม่พบผู้ใช้งานชื่อ "${targetUsername}" ในระบบครับ (เช็กตัวพิมพ์เล็ก-ใหญ่ให้ตรงเป๊ะๆ นะครับ)`);
    } else {
      console.log(`👑 อัปเกรดสำเร็จ! บัญชี "${res.rows[0].username}" เป็น ${res.rows[0].role} ของระบบ PORAWAT.PAY เรียบร้อยแล้ว!`);
    }
  } catch (err) { 
    console.error('❌ เกิดข้อผิดพลาด:', err.message); 
  } finally { 
    await client.end(); 
  }
}

makeAdmin();

