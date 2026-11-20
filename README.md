# OrbitOps — Enterprise Release & Deployment Management Portal

[![Node.js v24+](https://img.shields.io/badge/Node.js-v24%2B-brightgreen)](https://nodejs.org/)
[![Zero External Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(Native%20Stdlib)-blue)](https://nodejs.org/api/)
[![Tests Passing](https://img.shields.io/badge/Tests-14%2F14%20Passing-emerald)](./test.js)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./package.json)

**OrbitOps** is an enterprise-grade Continuous Delivery, Release Orchestration, and Fleet Governance Platform. Designed for modern microservices architectures and high-velocity engineering organizations, it combines the continuous delivery power of ArgoCD/Spinnaker, the governance of ServiceNow CAB, the feature and traffic control of LaunchDarkly, and real-time observability.

---

## 🚀 Key Highlights & Capabilities

### 1. 🌐 Multi-Environment Fleet & Version Drift Matrix
- Real-time fleet health across **Development**, **QA Integration**, **Staging (Pre-Prod)**, **Canary Slice (10% Traffic)**, **Production (US-East)**, and **Production (EU-Central)**.
- **Visual Version Drift Matrix**: Instantly detects and flags release drift between pre-prod soak clusters and live customer-facing clusters.
- **Environment Freeze Controls**: 1-click lock for Black Friday, holiday freezes, or database maintenance windows with mandatory CAB emergency bypass validation.

### 2. ⚡ Live Pipeline Orchestrator & Streaming Telemetry
- Supports **Canary (Traffic Shifting 10% → 25% → 50% → 100%)**, **Blue/Green Cluster Cutover**, and **Rolling Pod Replacement (25% batch step)**.
- **7-Stage Visual Pipeline**:
  1. Pre-flight & Resource Quota Verification
  2. Cosign Artifact Signature & SBOM Vulnerability Scan (Trivy / Snyk)
  3. Lock-Free Zero-Downtime Database Migration Dry-Run
  4. Pod Deployment & Synthetic Warmup Health Probes
  5. Automated SLI/SLO Canary Health Gate Analysis (Error rate & P99 latency thresholds)
  6. Ingress Traffic Cutover & Connection Draining
  7. Post-Deploy Synthetic Verification & Smoke Tests
- **Real-Time Live Streaming Terminal**: Powered by Server-Sent Events (`/api/deployments/:id/events`) with colored ANSI log levels, timestamps, and live stage progress.
- **Interactive Canary Traffic Slider**: Adjust canary weights on-the-fly during rollout.

### 3. 🚨 Automated Emergency Circuit Breaker & Instant Rollback
- 1-click **Instant Rollback**: Automatically cuts traffic back to the previous stable baseline within seconds, invalidates stale caches, restores replica sets, and logs incident MTTR.

### 4. 🛡️ Change Advisory Board (CAB) & Governance Engine
- Dynamic automated risk scoring algorithm (0–100 score + Low/Medium/High/Critical tier) factoring in:
  - Microservice criticality (Tier-0 vs Tier-1/2)
  - SemVer bump type (Major vs Minor vs Patch)
  - Relational database schema alteration flags
  - Friday deployment penalty (+15 risk points)
- Dual-authorization enforcement for High/Critical releases (e.g. Release Engineering Lead + Security Officer sign-offs).

### 5. 📑 Automated Release Notes & Changelog Generator
- Compiles PR commits, issue references, executive summaries, bug mitigations, breaking changes, and migration scripts.
- 1-click export to **Markdown** or styled **HTML** with clipboard copy.

### 6. 🔍 Environment Variable & Secret Drift Auditor
- Side-by-side configuration diffing between environments (e.g., Staging vs Prod-US).
- Masked secret security with SHA-256 digest comparison (`●●●●●●●● (sha256: 9b2c..)`), ensuring identical configuration without leaking credentials.

### 7. 📈 DevOps Research & Assessment (DORA) Metrics Hub
- Real-time tracking of the Four Key DORA Metrics:
  - **Deployment Frequency (DF)**: 16.4 deploys/week (*Elite Tier*)
  - **Lead Time for Changes (LTTC)**: 3.2 hours commit-to-prod (*Elite Tier*)
  - **Change Failure Rate (CFR)**: 1.4% (*Elite Tier*)
  - **Mean Time to Recovery (MTTR)**: 12.8 minutes (*Elite Tier*)
- Interactive Chart.js trends, commit-to-prod pipeline breakdown, and root cause distribution.

### 8. 📜 Immutable Audit Trail
- Cryptographically timestamped activity feed of all portal actions (`DEPLOYMENT_TRIGGERED`, `DEPLOYMENT_COMPLETED`, `ROLLBACK_EXECUTED`, `CAB_APPROVAL_GRANTED`, `ENVIRONMENT_FROZEN`).
- 1-click JSON backup export & restore (`/api/export`).

---

## 🛠️ Architecture & Technology Stack

- **Backend**: Native Node.js standard libraries (`http`, `fs`, `path`, `url`, `crypto`, `stream`, `events`). **Zero third-party npm dependencies required.**
- **Persistence**: ACID-safe atomic JSON file storage with temporary file swapping (`fs.renameSync`).
- **Real-Time Streaming**: Native Server-Sent Events (SSE).
- **Frontend**: Clean Single Page Application (SPA), responsive dark/light theme, Chart.js for telemetry graphs, custom high-density CSS styling.

---

## 🏁 Quickstart Guide

### 1. Start the Server
```bash
agy-node server.js
# Or standard Node.js:
node server.js
```
The portal starts on `http://localhost:3000`.

### 2. Run Automated Test Suite
```bash
agy-node test.js
```
Executes all 14 end-to-end integration tests validating endpoints, risk engines, pipeline execution, rollbacks, freeze gates, config diffs, and static assets.

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | System health, memory, and uptime |
| `GET` | `/api/overview` | Aggregated metrics, fleet health, DORA badges |
| `GET` | `/api/releases` | List release trains with query filters |
| `POST` | `/api/releases` | Create new SemVer release with auto risk scoring |
| `POST` | `/api/releases/:id/generate-notes` | Generate automated Markdown release notes |
| `GET` | `/api/deployments` | List deployments history |
| `POST` | `/api/deployments` | Trigger multi-stage deployment pipeline |
| `POST` | `/api/deployments/:id/rollback` | Emergency circuit breaker instant rollback |
| `POST` | `/api/deployments/:id/canary-traffic` | Dynamically override canary traffic weight |
| `GET` | `/api/deployments/:id/events` | Server-Sent Events (SSE) live telemetry stream |
| `GET` | `/api/environments` | Fleet status and version drift matrix |
| `POST` | `/api/environments/:id/freeze` | Toggle environment deployment freeze |
| `GET` | `/api/approvals` | List CAB gate requests |
| `POST` | `/api/approvals/:id/approve` | Grant Change Advisory Board approval |
| `POST` | `/api/approvals/:id/reject` | Reject release deployment |
| `GET` | `/api/configs/diff` | Compare environment configs & secrets |
| `GET` | `/api/dora` | DORA metrics and historical trend analytics |
| `GET` | `/api/audit-logs` | Immutable audit event log stream |
| `GET` | `/api/export` | Download complete portal backup snapshot |
| `POST` | `/api/reset-demo` | Restore clean pristine demonstration data |
