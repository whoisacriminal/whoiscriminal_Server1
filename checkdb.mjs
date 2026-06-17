import mysql from "mysql2/promise";
(async () => {
  try {
    const conn = await mysql.createConnection({host:'localhost', user:'root', password:'1017gksgo^^', database:'who_is_criminal', port:3306});
    const [rows1] = await conn.execute('SELECT id,name,playTime,criminalCaught,suspectId,suspectName,createdAt FROM rankings ORDER BY createdAt DESC LIMIT 20');
    const [rows2] = await conn.execute('SELECT suspectId,suspectName,picks,createdAt FROM suspect_picks ORDER BY picks DESC');
    console.log('RANKINGS:');
    console.log(JSON.stringify(rows1,null,2));
    console.log('SUSPECTS:');
    console.log(JSON.stringify(rows2,null,2));
    await conn.end();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
