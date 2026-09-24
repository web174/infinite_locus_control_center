# Multi-Tenant Student Readiness Control Center

A full-stack student readiness system designed to evaluate student competency across a multi-tenant environment.

## Project Overview

This project implements a multi-tenant student readiness control center with a React + TypeScript frontend, Node.js + Express backend, and PostgreSQL database.

The system focuses on:

- Multi-tenant student isolation
- Weighted readiness scoring
- Idempotent assessment-attempt submission
- Optimistic concurrency control for student updates
- Database-backed student and assessment data
- Auditing and operational traceability

## Core Features

### 1. Multi-Tenant Isolation

Student data is associated with a tenant and API operations are designed to prevent cross-tenant data access.

### 2. Weighted Readiness Scoring

Readiness is calculated using the following competency weights:

- Frontend: 30%
- Backend: 30%
- Databases: 25%
- Problem Solving: 15%

The readiness status is determined from the calculated score and competency completeness.

### 3. Idempotent Assessment Attempts

Assessment-attempt creation supports an `Idempotency-Key` so that repeated submissions of the same request do not create duplicate attempts.

### 4. Optimistic Concurrency Control

Student updates use a version value to prevent stale concurrent updates from overwriting newer data.

### 5. PostgreSQL Database

PostgreSQL stores the core relational application data, including tenants, students, assessment attempts, and idempotency records.

## Technology Stack

- **Frontend:** React + TypeScript
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL (Relational Source of Truth)
- **Database Driver:** `pg` (Node Postgres)
- **Activity Logging:** MongoDB (Optional Operational Logs)
- **Version Control:** Git + GitHub

## Project Structure

```text
infinite_locus_control_center/
├── frontend/
├── backend/
├── README.md
├── AI_LOG.md
├── DECISIONS.md
└── INCIDENT.md