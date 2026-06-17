import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

const isProduction = process.env.NODE_ENV === 'production'
if (!isProduction) {
  dotenv.config()
}

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors())
app.use(express.json())

const dbHost = process.env.DB_HOST || process.env.DATABASE_HOST || process.env.MYSQL_HOST
const dbUser = process.env.DB_USER || process.env.DATABASE_USER || process.env.MYSQL_USER
const dbPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || process.env.MYSQL_PASSWORD
const dbName = process.env.DB_NAME || process.env.DATABASE_NAME || process.env.MYSQL_DATABASE
const dbPort = process.env.DB_PORT || process.env.DATABASE_PORT || process.env.MYSQL_PORT

if (isProduction && dbHost === 'localhost') {
  console.error('⚠️  Production 환경에서 DB_HOST가 localhost로 설정되어 있습니다. Render 배포에서는 외부 DB 호스트를 사용해야 합니다.')
  process.exit(1)
}

// MySQL 연결 풀 생성 — Render 등에서 제공하는 환경변수만 사용합니다
const pool = mysql.createPool({
  host: dbHost,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  port: dbPort ? Number(dbPort) : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

// 빠른 검증용 경고(로컬 테스트 시 .env가 설정되어 있는지 확인하세요)
if (!dbHost || !dbUser || !dbPassword || !dbName) {
  console.warn('⚠️  DB 환경변수가 설정되지 않았습니다. Render의 환경변수 또는 .env 파일을 확인하세요.')
}

// 데이터베이스 초기화 함수 (재시도 로직 포함)
let dbConnected = false
async function initializeDatabase() {
  const maxAttempts = 5
  const baseDelay = 1000 // ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let connection
    try {
      connection = await pool.getConnection()

      // rankings 테이블 생성
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS rankings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          playTime INT NOT NULL COMMENT '초 단위',
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_name (name),
          INDEX idx_playTime (playTime),
          INDEX idx_createdAt (createdAt)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)

      await connection.execute(`ALTER TABLE rankings ADD COLUMN criminalCaught TINYINT(1) NOT NULL DEFAULT 0`).catch((err) => {
        if (!/Duplicate column name/.test(err.message)) throw err
      })
      await connection.execute(`ALTER TABLE rankings ADD COLUMN suspectId VARCHAR(50) DEFAULT NULL`).catch((err) => {
        if (!/Duplicate column name/.test(err.message)) throw err
      })
      await connection.execute(`ALTER TABLE rankings ADD COLUMN suspectName VARCHAR(100) DEFAULT NULL`).catch((err) => {
        if (!/Duplicate column name/.test(err.message)) throw err
      })

      await connection.execute(`
        CREATE TABLE IF NOT EXISTS suspect_picks (
          suspectId VARCHAR(50) PRIMARY KEY,
          suspectName VARCHAR(100) NOT NULL,
          picks INT NOT NULL DEFAULT 0,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)

      await connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)

      await connection.execute(`CREATE INDEX idx_criminalCaught ON rankings (criminalCaught)`).catch((err) => {
        if (!/Duplicate key name/.test(err.message) && !/already exists/.test(err.message)) throw err
      })

      console.log('✓ Rankings / suspect_picks / users 테이블 준비됨')
      dbConnected = true
      return
    } catch (error) {
      const isLast = attempt === maxAttempts
      console.error(`DB 초기화 시도 ${attempt} 실패:`, error.message)
      console.error('DB 연결 설정:', {
        host: process.env.DB_HOST || '<not set>',
        port: process.env.DB_PORT || '<not set>',
        user: process.env.DB_USER || '<not set>',
        database: process.env.DB_NAME || '<not set>',
      })

      if (error.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(error.message)) {
        console.error('⚠️  DB 연결이 거부되었습니다. Render에서 `DB_HOST`가 localhost로 설정되어 있지 않은지, 또는 외부에서 접근 가능한 DB 호스트를 사용중인지 확인하세요.')
      }

      if (connection) connection.release()

      if (isLast) break
      const delay = baseDelay * Math.pow(2, attempt - 1)
      console.log(`다음 시도까지 ${delay}ms 대기합니다...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  console.error('DB 초기화 실패: 모든 재시도 실패. 서버는 DB 없이 시작됩니다 (일부 기능 제한).')
}

// API 엔드포인트

// 1. 새로운 랭킹 기록 생성
app.post('/api/rankings', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 연결 불가' })
  const { name, playTime, criminalCaught = false, suspectId = null, suspectName = null } = req.body

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: '유효한 이름이 필요합니다' })
  }

  if (typeof playTime !== 'number' || playTime < 0) {
    return res.status(400).json({ error: '유효한 플레이 시간이 필요합니다' })
  }

  if (typeof criminalCaught !== 'boolean') {
    return res.status(400).json({ error: 'criminalCaught는 boolean이어야 합니다' })
  }

  try {
    const connection = await pool.getConnection()
    try {
      const [result] = await connection.execute(
        'INSERT INTO rankings (name, playTime, criminalCaught, suspectId, suspectName) VALUES (?, ?, ?, ?, ?)',
        [
          name.trim(),
          Math.round(playTime),
          criminalCaught ? 1 : 0,
          suspectId,
          suspectName,
        ]
      )

      if (suspectId && typeof suspectId === 'string') {
        await connection.execute(
          `INSERT INTO suspect_picks (suspectId, suspectName, picks)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE
             suspectName = VALUES(suspectName),
             picks = picks + 1`,
          [suspectId, suspectName || suspectId]
        )
      }

      res.status(201).json({
        id: result.insertId,
        name: name.trim(),
        playTime: Math.round(playTime),
        criminalCaught,
        suspectId,
        suspectName,
        createdAt: new Date().toISOString(),
      })
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('랭킹 생성 오류:', error)
    res.status(500).json({ error: '랭킹 저장에 실패했습니다' })
  }
})

// 2. 사용자 이름 저장
app.post('/api/users', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 연결 불가' })
  const { name } = req.body

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: '유효한 이름이 필요합니다' })
  }

  try {
    const connection = await pool.getConnection()
    try {
      // 중복 이름이면 기존 id를 재사용하도록 LAST_INSERT_ID 트릭 사용
      const [result] = await connection.execute(
        `INSERT INTO users (name)
         VALUES (?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [name.trim()]
      )

      const id = result.insertId || null
      res.status(201).json({ id, name: name.trim(), createdAt: new Date().toISOString() })
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('사용자 저장 오류:', error)
    res.status(500).json({ error: '사용자 저장에 실패했습니다' })
  }
})

// 모든 랭킹 조회 (빠른 순서대로)
app.get('/api/rankings', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 연결 불가' })
  try {
    const connection = await pool.getConnection()
    try {
      const [rows] = await connection.execute(
        `SELECT r.* FROM rankings r
         JOIN (
           SELECT name, MIN(playTime) AS bestPlayTime
           FROM rankings
           GROUP BY name
         ) best ON r.name = best.name AND r.playTime = best.bestPlayTime
         WHERE r.createdAt = (
           SELECT MIN(createdAt)
           FROM rankings r2
           WHERE r2.name = r.name AND r2.playTime = best.bestPlayTime
         )
         ORDER BY r.playTime ASC, r.createdAt ASC
         LIMIT 100`
      )

      // 순위 계산 (플레이 시간 짧은 순, 동률 시 먼저 등록된 기록이 우선)
      const rankingsWithRank = rows.map((record, index) => ({
        ...record,
        criminalCaught: Boolean(record.criminalCaught),
        rank: index + 1,
      }))

      res.json(rankingsWithRank)
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('랭킹 조회 오류:', error)
    res.status(500).json({ error: '랭킹 조회에 실패했습니다' })
  }
})

// 특정 용의자 통계 조회
app.get('/api/suspects', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 연결 불가' })
  try {
    const connection = await pool.getConnection()
    try {
      const [rows] = await connection.execute(
        `SELECT suspectId, suspectName, picks
         FROM suspect_picks
         ORDER BY picks DESC, suspectName ASC`
      )

      const totalPicks = rows.reduce((sum, row) => sum + row.picks, 0)
      const stats = rows.map((row) => ({
        suspectId: row.suspectId,
        suspectName: row.suspectName,
        picks: row.picks,
        percentage: totalPicks ? Math.round((row.picks / totalPicks) * 100) : 0,
      }))

      res.json({ totalPicks, stats })
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('용의자 통계 조회 오류:', error)
    res.status(500).json({ error: '용의자 통계 조회에 실패했습니다' })
  }
})

// 특정 사용자의 최신 기록 조회
app.get('/api/rankings/user/:name', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: 'DB 연결 불가' })
  const { name } = req.params

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: '유효한 이름이 필요합니다' })
  }

  try {
    const connection = await pool.getConnection()
    try {
      const [rows] = await connection.execute(
        `SELECT * FROM rankings 
         WHERE name = ? 
         ORDER BY createdAt DESC 
         LIMIT 1`,
        [name.trim()]
      )

      if (rows.length === 0) {
        return res.status(404).json({ error: '사용자 기록을 찾을 수 없습니다' })
      }

      // 현재 사용자의 순위 계산
      const [rankRows] = await connection.execute(
        `SELECT COUNT(*) as rank FROM rankings 
         WHERE playTime < ? 
         OR (playTime = ? AND createdAt < ?)`,
        [rows[0].playTime, rows[0].playTime, rows[0].createdAt]
      )

      const userRank = rankRows[0].rank + 1

      res.json({
        ...rows[0],
        rank: userRank,
      })
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('사용자 랭킹 조회 오류:', error)
    res.status(500).json({ error: '조회에 실패했습니다' })
  }
})

// 헬스 체크
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// 에러 핸들링
app.use((err, req, res, next) => {
  console.error('서버 에러:', err)
  res.status(500).json({ error: '서버 오류가 발생했습니다' })
})

// 서버 시작
async function startServer() {
  try {
    await initializeDatabase()

    app.listen(PORT, () => {
      console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다`)
      console.log(`📊 API 엔드포인트: /api/rankings`)
      if (!dbConnected) console.warn('⚠️ DB가 연결되지 않았습니다. 일부 엔드포인트는 동작하지 않을 수 있습니다.')
    })
  } catch (error) {
    console.error('서버 시작 중 처리되지 않은 오류:', error)
    // DB 초기화가 치명적이지 않도록 프로세스 종료하지 않습니다.
    app.listen(PORT, () => {
      console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다 (비정상 모드)`)
      if (!dbConnected) console.warn('⚠️ DB가 연결되지 않았습니다. 일부 엔드포인트는 동작하지 않을 수 있습니다.')
    })
  }
}

startServer()

export default app
