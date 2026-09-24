-- 1. Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Students Table with Versioning
CREATE TABLE IF NOT EXISTS students (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    current_score NUMERIC(5,2) DEFAULT 0.00,
    readiness_status VARCHAR(32) DEFAULT 'INCOMPLETE',
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Student Attempts Table
CREATE TABLE IF NOT EXISTS student_attempts (
    id VARCHAR(64) PRIMARY KEY,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    competency VARCHAR(64) NOT NULL,
    score NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Idempotency Records Table
CREATE TABLE IF NOT EXISTS idempotency_records (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(255) NOT NULL,
    response_body JSONB NOT NULL,
    status_code INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT idx_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_students_tenant ON students(tenant_id);
CREATE INDEX IF NOT EXISTS idx_attempts_student_comp ON student_attempts(student_id, competency);