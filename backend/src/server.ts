import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createHash } from 'crypto';


import { pool } from './db';
import { calculateReadiness } from './scoring';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const sendError = (
  res: express.Response,
  statusCode: number,
  code: string,
  message: string
) => {
  return res.status(statusCode).json({
    error: {
      code,
      message,
      requestId: `req-${Date.now()}`,
    },
  });
};

app.get('/', (req, res) => {
  res.json({
    message: 'Backend server is running',
  });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    res.json({
      status: 'OK',
      database: 'Connected',
      time: result.rows[0].now,
    });
  } catch (error) {
  return sendError(
    res,
    500,
    'DB_CONNECTION_ERROR',
    'Database not connected'
  );
  }
});

app.get('/api/students', async (req, res) => {
  const tenantId =
    (req.headers['x-tenant-id'] as string) || 't-default';

  const {
  status,
  q,
  page = '1',
  limit = '10',
} = req.query;

const pageNum = Math.max(
  1,
  parseInt(page as string, 10) || 1
);

const limitNum = Math.min(
  100,
  Math.max(
    1,
    parseInt(limit as string, 10) || 10
  )
);

const offset = (pageNum - 1) * limitNum;

  try {
    let queryText =
      'SELECT * FROM students WHERE tenant_id = $1';

    const queryParams: any[] = [tenantId];

    if (status && typeof status === 'string') {
      queryParams.push(status);

      queryText += ` AND readiness_status = $${queryParams.length}`;
    }

    if (q && typeof q === 'string') {
      queryParams.push(`%${q}%`);

      queryText += ` AND name ILIKE $${queryParams.length}`;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;

queryParams.push(limitNum, offset);

    const result = await pool.query(
      queryText,
      queryParams
    );

  res.json({
  items: result.rows,
  page: pageNum,
  limit: limitNum,
});


  } catch (error: any) {
  return sendError(
    res,
    500,
    'INTERNAL_SERVER_ERROR',
    'An unexpected error occurred'
  );
 }
});


app.get('/api/students/:id', async (req, res) => {
  const tenantId =
    (req.headers['x-tenant-id'] as string) || 't-default';

  const { id } = req.params;

  try {
    const studentResult = await pool.query(
      'SELECT * FROM students WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );

    if (studentResult.rows.length === 0) {
  return sendError(
    res,
    404,
    'STUDENT_NOT_FOUND',
    'Student not found in this tenant'
  );
}

    const attemptsResult = await pool.query(
      `SELECT *
       FROM student_attempts
       WHERE student_id = $1
       AND tenant_id = $2
       ORDER BY created_at DESC`,
      [id, tenantId]
    );

    res.json({
      student: studentResult.rows[0],
      attempts: attemptsResult.rows,
    });
  } catch (error: any) {
  return sendError(
    res,
    500,
    'INTERNAL_SERVER_ERROR',
    'An unexpected error occurred'
  );
 }
});

app.patch('/api/students/:id', async (req, res) => {
  const tenantId =
    (req.headers['x-tenant-id'] as string) || 't-default';

  const { id } = req.params;
  const { name, version } = req.body;

  if (typeof name !== 'string' || name.trim() === '') {
    return sendError(
      res,
      400,
      'INVALID_NAME',
      'name is required and must be a non-empty string'
    );
  }

  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    return sendError(
      res,
      400,
      'INVALID_VERSION',
      'version is required and must be a non-negative integer'
    );
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const studentResult = await client.query(
      `SELECT id, name, version
       FROM students
       WHERE id = $1
       AND tenant_id = $2
       FOR UPDATE`,
      [id, tenantId]
    );

    if (studentResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return sendError(
        res,
        404,
        'STUDENT_NOT_FOUND',
        'Student not found in this tenant'
      );
    }

    const student = studentResult.rows[0];

    if (student.version !== version) {
      await client.query('ROLLBACK');

      return sendError(
        res,
        409,
        'VERSION_CONFLICT',
        'Student was modified by another request'
      );
    }

    const updatedStudentResult = await client.query(
      `UPDATE students
       SET name = $1,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       AND tenant_id = $3
       AND version = $4
       RETURNING *`,
      [name.trim(), id, tenantId, version]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'Student updated successfully',
      student: updatedStudentResult.rows[0],
    });
  } catch (error: any) {
    await client.query('ROLLBACK');

    console.error('Student update error:', error);

    return sendError(
      res,
      500,
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred'
    );
  } finally {
    client.release();
  }
});

app.post('/api/students/:id/attempts', async (req, res) => {
  const tenantId =
    (req.headers['x-tenant-id'] as string) || 't-default';

  const idempotencyKey =
    req.headers['idempotency-key'] as string | undefined;

  const { id: studentId } = req.params;
  const { competency, score } = req.body;

  if (!idempotencyKey) {
  return sendError(
    res,
    400,
    'MISSING_IDEMPOTENCY_KEY',
    'Idempotency-Key header is required'
  );
}

  const allowedCompetencies = [
    'frontend',
    'backend',
    'databases',
    'problem_solving',
  ];

  if (
  typeof competency !== 'string' ||
  !allowedCompetencies.includes(competency)
) {
  return sendError(
    res,
    400,
    'INVALID_COMPETENCY',
    'competency must be one of: frontend, backend, databases, problem_solving'
  );
}

  if (
  typeof score !== 'number' ||
  !Number.isFinite(score) ||
  score < 0 ||
  score > 100
) {
  return sendError(
    res,
    400,
    'INVALID_SCORE',
    'score must be a number between 0 and 100'
  );
}

  const requestPayload = {
    studentId,
    competency,
    score,
  };

  const requestHash = createHash('sha256')
    .update(JSON.stringify(requestPayload))
    .digest('hex');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `SELECT pg_advisory_xact_lock(
        hashtextextended($1, 0)
      )`,
      [`${tenantId}:${idempotencyKey}`]
    );

    const existingIdempotency = await client.query(
      `SELECT
         request_hash,
         response_body,
         status_code
       FROM idempotency_records
       WHERE tenant_id = $1
       AND idempotency_key = $2`,
      [
        tenantId,
        idempotencyKey,
      ]
    );

    if (existingIdempotency.rows.length > 0) {
      const existing = existingIdempotency.rows[0];

      if (existing.request_hash !== requestHash) {
  await client.query('ROLLBACK');

  return sendError(
    res,
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'Idempotency-Key has already been used with a different request'
  );
}

      await client.query('COMMIT');

      return res
        .status(existing.status_code)
        .json(existing.response_body);
    }

    const studentResult = await client.query(
      `SELECT *
       FROM students
       WHERE id = $1
       AND tenant_id = $2
       FOR UPDATE`,
      [
        studentId,
        tenantId,
      ]
    );

    if (studentResult.rows.length === 0) {
      const responseBody = {
  error: {
    code: 'STUDENT_NOT_FOUND',
    message: 'Student not found',
    requestId: `req-${Date.now()}`,
  },
};

      await client.query(
        `INSERT INTO idempotency_records
         (
           tenant_id,
           idempotency_key,
           request_hash,
           response_body,
           status_code
         )
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          idempotencyKey,
          requestHash,
          JSON.stringify(responseBody),
          404,
        ]
      );

      await client.query('COMMIT');

      return res.status(404).json(responseBody);
    }

    const attemptId =
      `att-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`;

    await client.query(
      `INSERT INTO student_attempts
       (
         id,
         student_id,
         tenant_id,
         competency,
         score
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attemptId,
        studentId,
        tenantId,
        competency,
        score,
      ]
    );

    const latestAttemptsResult = await client.query(
      `SELECT DISTINCT ON (competency)
         competency,
         score
       FROM student_attempts
       WHERE student_id = $1
       AND tenant_id = $2
       ORDER BY competency, created_at DESC, id DESC`,
      [
        studentId,
        tenantId,
      ]
    );

    const scores: {
      frontend?: number;
      backend?: number;
      databases?: number;
      problem_solving?: number;
    } = {};

    for (const row of latestAttemptsResult.rows) {
      if (row.competency === 'frontend') {
        scores.frontend = Number(row.score);
      }

      if (row.competency === 'backend') {
        scores.backend = Number(row.score);
      }

      if (row.competency === 'databases') {
        scores.databases = Number(row.score);
      }

      if (row.competency === 'problem_solving') {
        scores.problem_solving = Number(row.score);
      }
    }

    const readiness =
      calculateReadiness(scores);

    const updatedStudentResult = await client.query(
      `UPDATE students
       SET
         current_score = $1,
         readiness_status = $2,
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       AND tenant_id = $4
       RETURNING *`,
      [
        readiness.score,
        readiness.status,
        studentId,
        tenantId,
      ]
    );

    const responseBody = {
      message: 'Attempt submitted successfully',

      attempt: {
        id: attemptId,
        student_id: studentId,
        tenant_id: tenantId,
        competency,
        score,
      },

      readiness,

      student: updatedStudentResult.rows[0],
    };

    await client.query(
      `INSERT INTO idempotency_records
       (
         tenant_id,
         idempotency_key,
         request_hash,
         response_body,
         status_code
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        idempotencyKey,
        requestHash,
        JSON.stringify(responseBody),
        201,
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json(responseBody);

  } catch (error: any) {
  await client.query('ROLLBACK');

  console.error(
    'Attempt submission error:',
    error
  );

  return sendError(
    res,
    500,
    'INTERNAL_SERVER_ERROR',
    'An unexpected error occurred'
  );
} finally {
  client.release();
  }
});


const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});