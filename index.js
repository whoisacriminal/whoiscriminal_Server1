import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import path from 'path'
import { fileURLToPath } from 'url'

// ==============================
// ENV LOADING (핵심 수정)
// ==============================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// .env 강제 로딩 (이게 핵심)
dotenv.config({ path: path.join(__dirname, '.env') })

console.log('ENV CHECK:', {
  DB_HOST: process.env.DB_HOST,
  DB_USER: process.env.DB_USER,
  DB_NAME: process.env.DB_NAME,
})

// ==============================
// APP SETUP
// ==============================
const app = express()
const PORT = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

// ==============================
// DB CONFIG
// ==============================
const dbHost = process.env.DB_HOST || 'localhost'
const dbUser = process.env.DB_USER || 'root'
const dbPassword = process.env.DB_PASSWORD || ''
const dbName = process.env.DB_NAME || 'who_is_criminal'
const dbPort = Number(process.env.DB_PORT || 3306)

// ==============================
// MYSQL POOL
// ==============================
const pool = mysql.createPool({
  host: dbHost,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  port: dbPort,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

// ==============================
// DB STATUS CHECK
// ==============================
let dbConnected = false

if (!dbHost || !dbUser || !dbName) {
  console.warn('⚠️ DB 환경변수 부족 (연결 실패 가능)')
}

// ==============================
// DATABASE INIT
// ==============================
async function initializeDatabase() {
  const maxAttempts = 5
  const baseDelay = 1000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let connection

    try {
      connection = await pool.getConnection()

      await connection.execute(`
        CREATE TABLE IF NOT EXISTS rankings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          playTime INT NOT NULL,
          criminalCaught TINYINT(1) NOT NULL DEFAULT 0,
          suspectId VARCHAR(50),
          suspectName VARCHAR(100),
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      await connection.execute(`
        CREATE TABLE IF NOT EXISTS suspect_picks (
          suspectId VARCHAR(50) PRIMARY KEY,
          suspectName VARCHAR(100),
          picks INT DEFAULT 0
        )
      `)

      await connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) UNIQUE
        )
      `)

      console.log('✅ DB 테이블 준비 완료')
      dbConnected = true
      return
    } catch (err) {
      console.error(`DB 초기화 실패 (${attempt}):`, err.message)

      if (connection) connection.release()

      if (attempt === maxAttempts) break

      await new Promise(r => setTimeout(r, baseDelay * attempt))
    }
  }

  console.error('❌ DB 초기화 최종 실패')
}

// ==============================
// API
// ==============================

// 랭킹 생성
app.post('/api/rankings', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 없음' })

  const { name, playTime, criminalCaught, suspectId, suspectName } = req.body

  if (!name || typeof playTime !== 'number') {
    return res.status(400).json({ error: 'name 및 playTime 필요' })
  }

  try {
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()

      const [result] = await conn.execute(
        `INSERT INTO rankings (name, playTime, criminalCaught, suspectId, suspectName)
         VALUES (?, ?, ?, ?, ?)`,
        [
          name,
          playTime,
          criminalCaught ? 1 : 0,
          suspectId || null,
          suspectName || null,
        ]
      )

      if (suspectId && suspectName) {
        await conn.execute(
          `INSERT INTO suspect_picks (suspectId, suspectName, picks)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE picks = picks + 1`,
          [suspectId, suspectName]
        )
      }

      await conn.execute(
        `INSERT IGNORE INTO users (name) VALUES (?)`,
        [name]
      )

      await conn.commit()

      res.status(201).json({ id: result.insertId })
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'insert fail' })
  }
})

// 랭킹 조회
app.get('/api/rankings', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 없음' })

  try {
    const conn = await pool.getConnection()

    try {
      const [rows] = await conn.execute(
        `SELECT id, name, playTime, criminalCaught, suspectId, suspectName, createdAt
         FROM rankings
         ORDER BY playTime ASC, createdAt ASC
         LIMIT 100`
      )

      res.json(rows)
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'select fail' })
  }
})

// 특정 사용자 최신 랭킹 조회
app.get('/api/rankings/user/:name', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 없음' })

  const name = req.params.name

  try {
    const conn = await pool.getConnection()

    try {
      const [rows] = await conn.execute(
        `SELECT id, name, playTime, criminalCaught, suspectId, suspectName, createdAt
         FROM rankings
         WHERE name = ?
         ORDER BY createdAt DESC
         LIMIT 1`,
        [name]
      )

      if (rows.length === 0) {
        return res.status(404).json({ error: 'not found' })
      }

      res.json(rows[0])
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'select fail' })
  }
})

// 최다 지목 통계 조회
app.get('/api/mostsuspected', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 없음' })

  try {
    const conn = await pool.getConnection()

    try {
      const [rows] = await conn.execute(
        `SELECT suspectId, suspectName, picks
         FROM suspect_picks
         ORDER BY picks DESC, suspectName ASC
         LIMIT 10`
      )

      res.json(rows)
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'select fail' })
  }
})

// 헬스체크
app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

// ==============================
// START SERVER
// ==============================
async function startServer() {
  await initializeDatabase()

  app.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`)
  })
}

startServer()

export default app