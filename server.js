/**
 * OrbitOps - Enterprise Release & Deployment Management Portal
 * Native Node.js Server & REST API Engine (Zero external dependencies)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// File paths for persistence
const RELEASES_FILE = path.join(DATA_DIR, 'releases.json');
const DEPLOYMENTS_FILE = path.join(DATA_DIR, 'deployments.json');
const ENVIRONMENTS_FILE = path.join(DATA_DIR, 'environments.json');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');
const DORA_FILE = path.join(DATA_DIR, 'dora_metrics.json');
const CONFIGS_FILE = path.join(DATA_DIR, 'configs.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit_logs.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(PUBLIC_DIR, 'css'))) {
  fs.mkdirSync(path.join(PUBLIC_DIR, 'css'), { recursive: true });
}
if (!fs.existsSync(path.join(PUBLIC_DIR, 'js'))) {
  fs.mkdirSync(path.join(PUBLIC_DIR, 'js'), { recursive: true });
}

// MIME Types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// Safe JSON File I/O
function readJson(filePath, defaultValue = []) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  try {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
    return false;
  }
}

// Audit Logger
function logAudit(action, actor, target, environment, details, status = 'SUCCESS') {
  const auditLogs = readJson(AUDIT_FILE, []);
  const entry = {
    id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    action,
    actor: actor || 'system.automator@orbitcorp.internal',
    target,
    environment: environment || 'ALL',
    details,
    status
  };
  auditLogs.unshift(entry);
  if (auditLogs.length > 500) auditLogs.pop(); // keep last 500 events
  writeJson(AUDIT_FILE, auditLogs);
  return entry;
}

// Helper: Parse Request Body
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e7) { // 10MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Helper: Send JSON Response
function sendJson(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers
  });
  res.end(JSON.stringify(data));
}

// Helper: Serve Static File
function serveStaticFile(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(fallbackPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(fallbackPath).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(resolvedPath).pipe(res);
  });
}

// In-Memory Active Deployment Run Loops & SSE Listeners
const activeDeploymentJobs = new Map();
const deploymentSseClients = new Map(); // deploymentId -> Set of res objects

function broadcastDeploymentLog(deploymentId, logMessage, level = 'INFO', stageIndex = null) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, message: logMessage, level };
  
  // Update persistence
  const deployments = readJson(DEPLOYMENTS_FILE, []);
  const dep = deployments.find(d => d.id === deploymentId);
  if (dep) {
    dep.logs = dep.logs || [];
    dep.logs.push(logEntry);
    if (stageIndex !== null && dep.stages && dep.stages[stageIndex]) {
      dep.currentStageIndex = stageIndex;
    }
    writeJson(DEPLOYMENTS_FILE, deployments);
  }

  // Push to SSE clients
  const clients = deploymentSseClients.get(deploymentId);
  if (clients && clients.size > 0) {
    const sseData = JSON.stringify({ type: 'log', log: logEntry, stageIndex, deployment: dep });
    clients.forEach(clientRes => {
      clientRes.write(`data: ${sseData}\n\n`);
    });
  }
}

function broadcastDeploymentUpdate(deploymentId, updatePayload) {
  const deployments = readJson(DEPLOYMENTS_FILE, []);
  const dep = deployments.find(d => d.id === deploymentId);
  if (dep) {
    Object.assign(dep, updatePayload);
    writeJson(DEPLOYMENTS_FILE, deployments);
  }

  const clients = deploymentSseClients.get(deploymentId);
  if (clients && clients.size > 0) {
    const sseData = JSON.stringify({ type: 'status_update', deployment: dep });
    clients.forEach(clientRes => {
      clientRes.write(`data: ${sseData}\n\n`);
    });
  }
}

// Seed Initial Enterprise Data
function seedInitialData() {
  // 1. Environments
  if (!fs.existsSync(ENVIRONMENTS_FILE)) {
    const defaultEnvs = [
      {
        id: 'dev',
        name: 'Development',
        tier: 'development',
        region: 'us-east-1',
        status: 'healthy',
        isFrozen: false,
        freezeReason: '',
        frozenBy: '',
        cluster: 'k8s-dev-cluster-us',
        healthScore: 99.9,
        activeDeploymentsCount: 0,
        metrics: { cpuUsage: 38, memoryUsage: 54, errorRate: 0.04, p99LatencyMs: 42 }
      },
      {
        id: 'qa',
        name: 'QA & Integration',
        tier: 'testing',
        region: 'us-east-1',
        status: 'healthy',
        isFrozen: false,
        freezeReason: '',
        frozenBy: '',
        cluster: 'k8s-qa-cluster-01',
        healthScore: 99.4,
        activeDeploymentsCount: 0,
        metrics: { cpuUsage: 45, memoryUsage: 62, errorRate: 0.12, p99LatencyMs: 68 }
      },
      {
        id: 'staging',
        name: 'Staging (Pre-Prod)',
        tier: 'staging',
        region: 'us-west-2',
        status: 'healthy',
        isFrozen: false,
        freezeReason: '',
        frozenBy: '',
        cluster: 'k8s-staging-cluster-02',
        healthScore: 99.8,
        activeDeploymentsCount: 0,
        metrics: { cpuUsage: 52, memoryUsage: 68, errorRate: 0.02, p99LatencyMs: 76 }
      },
      {
        id: 'canary',
        name: 'Canary Fleet (10% Traffic)',
        tier: 'canary',
        region: 'us-east-1',
        status: 'healthy',
        isFrozen: false,
        freezeReason: '',
        frozenBy: '',
        cluster: 'k8s-prod-canary-slice',
        healthScore: 100,
        activeDeploymentsCount: 0,
        metrics: { cpuUsage: 41, memoryUsage: 58, errorRate: 0.01, p99LatencyMs: 79 }
      },
      {
        id: 'prod-us',
        name: 'Production (US-East)',
        tier: 'production',
        region: 'us-east-1',
        status: 'healthy',
        isFrozen: false,
        freezeReason: '',
        frozenBy: '',
        cluster: 'k8s-prod-us-primary',
        healthScore: 99.98,
        activeDeploymentsCount: 0,
        metrics: { cpuUsage: 64, memoryUsage: 73, errorRate: 0.01, p99LatencyMs: 82 }
      },
      {
        id: 'prod-eu',
        name: 'Production (EU-Central)',
        tier: 'production',
        region: 'eu-central-1',
        status: 'healthy',
        isFrozen: false,
        freezeReason: '',
        frozenBy: '',
        cluster: 'k8s-prod-eu-dr',
        healthScore: 99.95,
        activeDeploymentsCount: 0,
        metrics: { cpuUsage: 58, memoryUsage: 69, errorRate: 0.01, p99LatencyMs: 91 }
      }
    ];
    writeJson(ENVIRONMENTS_FILE, defaultEnvs);
  }

  // 2. Services
  if (!fs.existsSync(SERVICES_FILE)) {
    const defaultServices = [
      {
        id: 'svc-payments',
        name: 'Payment Gateway Bridge',
        slug: 'payment-gateway',
        tier: 'Tier-0 (Mission Critical)',
        team: 'Core Payments & Ledger',
        lead: 'Elena Rostova (Staff SRE)',
        repo: 'github.com/orbitcorp/payment-gateway',
        language: 'Go 1.22 / gRPC',
        defaultStrategy: 'canary',
        dependencies: ['svc-auth', 'svc-vault'],
        currentVersions: {
          dev: 'v3.4.1-rc1',
          qa: 'v3.4.0',
          staging: 'v3.4.0',
          canary: 'v3.4.0',
          'prod-us': 'v3.3.8',
          'prod-eu': 'v3.3.8'
        }
      },
      {
        id: 'svc-auth',
        name: 'Auth & OAuth2 Identity Token Server',
        slug: 'auth-service',
        tier: 'Tier-0 (Mission Critical)',
        team: 'Security & Identity',
        lead: 'Marcus Vance (Principal Eng)',
        repo: 'github.com/orbitcorp/auth-service',
        language: 'Rust / Actix-web',
        defaultStrategy: 'blue-green',
        dependencies: [],
        currentVersions: {
          dev: 'v2.19.0',
          qa: 'v2.18.2',
          staging: 'v2.18.2',
          canary: 'v2.18.1',
          'prod-us': 'v2.18.1',
          'prod-eu': 'v2.18.1'
        }
      },
      {
        id: 'svc-orders',
        name: 'Order Routing & Orchestration Engine',
        slug: 'order-orchestrator',
        tier: 'Tier-1 (High Impact)',
        team: 'Commerce Fulfilment',
        lead: 'Sarah Jenkins (Tech Lead)',
        repo: 'github.com/orbitcorp/order-service',
        language: 'TypeScript / Node.js 22',
        defaultStrategy: 'canary',
        dependencies: ['svc-payments', 'svc-inventory'],
        currentVersions: {
          dev: 'v4.1.0-alpha',
          qa: 'v4.0.2',
          staging: 'v4.0.1',
          canary: 'v4.0.1',
          'prod-us': 'v4.0.0',
          'prod-eu': 'v4.0.0'
        }
      },
      {
        id: 'svc-inventory',
        name: 'Real-time Inventory Ledger',
        slug: 'inventory-ledger',
        tier: 'Tier-1 (High Impact)',
        team: 'Supply Chain Engineering',
        lead: 'Carlos Mendoza',
        repo: 'github.com/orbitcorp/inventory-service',
        language: 'Java 21 / Spring Boot 3',
        defaultStrategy: 'rolling',
        dependencies: [],
        currentVersions: {
          dev: 'v1.8.4',
          qa: 'v1.8.3',
          staging: 'v1.8.3',
          canary: 'v1.8.2',
          'prod-us': 'v1.8.2',
          'prod-eu': 'v1.8.2'
        }
      },
      {
        id: 'svc-web',
        name: 'Customer Web Frontend (Next.js SSR)',
        slug: 'web-portal',
        tier: 'Tier-1 (High Impact)',
        team: 'Storefront Experience',
        lead: 'Aiko Tanaka',
        repo: 'github.com/orbitcorp/web-storefront',
        language: 'Next.js 15 / React 19',
        defaultStrategy: 'blue-green',
        dependencies: ['svc-orders', 'svc-auth'],
        currentVersions: {
          dev: 'v5.12.0',
          qa: 'v5.11.2',
          staging: 'v5.11.0',
          canary: 'v5.11.0',
          'prod-us': 'v5.10.4',
          'prod-eu': 'v5.10.4'
        }
      },
      {
        id: 'svc-notifications',
        name: 'Multi-Channel Push & Event Dispatcher',
        slug: 'notification-worker',
        tier: 'Tier-2 (Standard)',
        team: 'Engagement & Comms',
        lead: 'Devon Reed',
        repo: 'github.com/orbitcorp/notification-engine',
        language: 'Python 3.12 / FastAPI',
        defaultStrategy: 'rolling',
        dependencies: [],
        currentVersions: {
          dev: 'v2.4.0',
          qa: 'v2.3.9',
          staging: 'v2.3.9',
          canary: 'v2.3.8',
          'prod-us': 'v2.3.8',
          'prod-eu': 'v2.3.8'
        }
      }
    ];
    writeJson(SERVICES_FILE, defaultServices);
  }

  // 3. Releases
  if (!fs.existsSync(RELEASES_FILE)) {
    const defaultReleases = [
      {
        id: 'rel-2026-11-20-01',
        version: 'v3.4.0',
        title: 'Q4 Payment Gateway Resilience & Biometric Auth Rollout',
        serviceId: 'svc-payments',
        serviceName: 'Payment Gateway Bridge',
        status: 'approved',
        releaseType: 'minor',
        riskLevel: 'high',
        targetEnvironment: 'prod-us',
        author: 'Elena Rostova',
        authorEmail: 'elena.rostova@orbitcorp.internal',
        scheduledDate: '2026-11-20T17:30:00Z',
        cabStatus: 'approved',
        cabApprovalId: 'cab-4081',
        commitsCount: 18,
        pullRequests: [
          { id: '#1042', title: 'Add Stripe and Adyen multi-acquirer fallback routing', author: 'dchen', mergeDate: '2026-11-19' },
          { id: '#1049', title: 'Optimize Redis distributed idempotent token locking (P99 -42ms)', author: 'erostova', mergeDate: '2026-11-20' },
          { id: '#1055', title: 'Upgrade 3D-Secure 2.2 biometric transaction flow for PSD3 compliance', author: 'mkowalski', mergeDate: '2026-11-20' }
        ],
        releaseNotes: {
          highlights: 'Enterprise zero-downtime multi-acquirer failover engine with sub-80ms fallback guarantee and full PSD3 biometric authentication.',
          features: [
            'Dynamic multi-acquirer intelligent routing based on real-time bank settlement health.',
            'Zero-lock partitioned PostgreSQL migration for token transaction ledger.',
            'Instant 3D-Secure biometric verification bridge for mobile wallet payments.'
          ],
          bugFixes: [
            'Resolved concurrent webhook duplicate settlement race condition during network split (BUG-4912).',
            'Fixed exponential backoff jitter on webhook retry storm.'
          ],
          breakingChanges: [],
          databaseMigrations: [
            '20261120_create_acquirer_routing_rules.sql (backward compatible, lock-free)',
            '20261120_add_biometric_auth_audit_hash.sql'
          ]
        },
        checks: {
          sastScan: { status: 'passed', score: '0 Critical / 0 High', tool: 'SonarQube & Snyk SCA' },
          e2eTests: { status: 'passed', passed: 512, failed: 0, duration: '3m 44s' },
          perfBaseline: { status: 'passed', p99Diff: '-18ms improvement', baselineP99: '84ms' },
          dbMigrationDryRun: { status: 'passed', duration: '1.2s execution time (Lock-free)' },
          containerSignature: { status: 'passed', verified: true, signer: 'Cosign / Orbit KMS' }
        },
        createdAt: '2026-11-20T09:15:00Z'
      },
      {
        id: 'rel-2026-11-19-02',
        version: 'v2.18.2',
        title: 'OAuth2 Token Cache Invalidation & Session Revocation Fast-Track',
        serviceId: 'svc-auth',
        serviceName: 'Auth & OAuth2 Identity Token Server',
        status: 'released',
        releaseType: 'patch',
        riskLevel: 'low',
        targetEnvironment: 'prod-us',
        author: 'Marcus Vance',
        authorEmail: 'marcus.vance@orbitcorp.internal',
        scheduledDate: '2026-11-19T14:00:00Z',
        cabStatus: 'approved',
        commitsCount: 6,
        pullRequests: [
          { id: '#892', title: 'Implement Redis PubSub session revocation cluster broadcast', author: 'mvance', mergeDate: '2026-11-19' }
        ],
        releaseNotes: {
          highlights: 'Sub-millisecond global token revocation across multi-region edge nodes.',
          features: ['Redis cluster token invalidation pubsub channel.'],
          bugFixes: ['Fixed expired refresh token grace period boundary condition.'],
          breakingChanges: [],
          databaseMigrations: []
        },
        checks: {
          sastScan: { status: 'passed', score: '0 Critical', tool: 'Snyk' },
          e2eTests: { status: 'passed', passed: 310, failed: 0, duration: '2m 10s' },
          perfBaseline: { status: 'passed', p99Diff: '0ms', baselineP99: '28ms' },
          dbMigrationDryRun: { status: 'passed', duration: 'N/A' },
          containerSignature: { status: 'passed', verified: true, signer: 'Cosign' }
        },
        createdAt: '2026-11-19T11:00:00Z'
      },
      {
        id: 'rel-2026-11-18-03',
        version: 'v4.1.0-alpha',
        title: 'Global Checkout Distributed Sagas Engine',
        serviceId: 'svc-orders',
        serviceName: 'Order Routing & Orchestration Engine',
        status: 'in_review',
        releaseType: 'minor',
        riskLevel: 'critical',
        targetEnvironment: 'staging',
        author: 'Sarah Jenkins',
        authorEmail: 'sarah.jenkins@orbitcorp.internal',
        scheduledDate: '2026-11-21T10:00:00Z',
        cabStatus: 'pending',
        commitsCount: 34,
        pullRequests: [
          { id: '#412', title: 'Implement Temporal IO distributed saga pattern for multi-item orders', author: 'sjenkins', mergeDate: '2026-11-18' }
        ],
        releaseNotes: {
          highlights: 'Migrates order workflow state machine to idempotent distributed sagas with automatic compensating transactions.',
          features: ['Compensating transactions for failed payments and inventory reservation rollback.'],
          bugFixes: ['Fixed zombie order stuck in processing when payment provider drops TCP connection.'],
          breakingChanges: ['API /v1/orders/create deprecated in favor of /v2/orders/checkout-session'],
          databaseMigrations: ['20261118_temporal_workflow_executions.sql']
        },
        checks: {
          sastScan: { status: 'passed', score: '0 Critical / 1 Medium', tool: 'SonarQube' },
          e2eTests: { status: 'passed', passed: 724, failed: 0, duration: '6m 12s' },
          perfBaseline: { status: 'passed', p99Diff: '-22ms', baselineP99: '110ms' },
          dbMigrationDryRun: { status: 'passed', duration: '3.4s' },
          containerSignature: { status: 'passed', verified: true, signer: 'Cosign' }
        },
        createdAt: '2026-11-18T16:00:00Z'
      }
    ];
    writeJson(RELEASES_FILE, defaultReleases);
  }

  // 4. Deployments History
  if (!fs.existsSync(DEPLOYMENTS_FILE)) {
    const defaultDeployments = [
      {
        id: 'dep-9821',
        releaseId: 'rel-2026-11-19-02',
        serviceId: 'svc-auth',
        serviceName: 'Auth & OAuth2 Identity Token Server',
        version: 'v2.18.2',
        previousVersion: 'v2.18.1',
        environment: 'prod-us',
        strategy: 'blue-green',
        status: 'success',
        startedAt: '2026-11-19T14:10:00Z',
        completedAt: '2026-11-19T14:18:24Z',
        duration: '8m 24s',
        deployedBy: 'Marcus Vance',
        canaryTrafficPercent: 100,
        currentStageIndex: 6,
        stages: [
          { name: 'Pre-flight & Quota Verification', status: 'completed', duration: '14s' },
          { name: 'Artifact Signature & SBOM Validation', status: 'completed', duration: '22s' },
          { name: 'Deploy Green Cluster Pods (12/12 Replicas)', status: 'completed', duration: '2m 14s' },
          { name: 'Health Readiness Probes & Synthetic Pings', status: 'completed', duration: '1m 30s' },
          { name: 'Switch Ingress Router (Blue -> Green 100%)', status: 'completed', duration: '45s' },
          { name: 'Post-deploy Soak & SLI Analysis', status: 'completed', duration: '2m 30s' },
          { name: 'Tear Down Blue Cluster Standby', status: 'completed', duration: '49s' }
        ],
        logs: [
          { timestamp: '2026-11-19T14:10:01Z', level: 'INFO', message: 'Deployment triggered by user marcus.vance' },
          { timestamp: '2026-11-19T14:10:15Z', level: 'INFO', message: 'Cosign verified container image sha256:8b4e72a...' },
          { timestamp: '2026-11-19T14:12:30Z', level: 'INFO', message: 'All 12 Green pods reported HTTP 200 /healthz' },
          { timestamp: '2026-11-19T14:14:00Z', level: 'INFO', message: 'Ingress controller shifted 100% live traffic to Green' },
          { timestamp: '2026-11-19T14:18:24Z', level: 'INFO', message: 'Deployment successfully verified without errors. Zero dropped connections.' }
        ],
        metricsSnapshot: { errorRate: '0.00%', p99Latency: '24ms', cpuUtil: '46%' }
      },
      {
        id: 'dep-9820',
        releaseId: 'rel-2026-11-19-01',
        serviceId: 'svc-inventory',
        serviceName: 'Real-time Inventory Ledger',
        version: 'v1.8.3',
        previousVersion: 'v1.8.2',
        environment: 'staging',
        strategy: 'rolling',
        status: 'success',
        startedAt: '2026-11-19T11:00:00Z',
        completedAt: '2026-11-19T11:06:12Z',
        duration: '6m 12s',
        deployedBy: 'Carlos Mendoza',
        canaryTrafficPercent: 100,
        currentStageIndex: 4,
        stages: [
          { name: 'Pre-flight Validation', status: 'completed', duration: '12s' },
          { name: 'Rolling Pod Replacement (25% step)', status: 'completed', duration: '3m 15s' },
          { name: 'DB Connection Pool Health Probe', status: 'completed', duration: '1m 10s' },
          { name: 'Traffic Drainage & Final Verification', status: 'completed', duration: '1m 35s' }
        ],
        logs: [
          { timestamp: '2026-11-19T11:00:00Z', level: 'INFO', message: 'Starting rolling deployment of inventory-ledger v1.8.3' },
          { timestamp: '2026-11-19T11:06:12Z', level: 'INFO', message: 'Rolling deployment complete on staging cluster.' }
        ],
        metricsSnapshot: { errorRate: '0.01%', p99Latency: '34ms', cpuUtil: '51%' }
      }
    ];
    writeJson(DEPLOYMENTS_FILE, defaultDeployments);
  }

  // 5. CAB Approvals
  if (!fs.existsSync(APPROVALS_FILE)) {
    const defaultApprovals = [
      {
        id: 'cab-4081',
        releaseId: 'rel-2026-11-20-01',
        title: 'v3.4.0 Deployment to Production (US-East)',
        service: 'Payment Gateway Bridge',
        targetEnv: 'prod-us',
        requestedBy: 'Elena Rostova',
        riskLevel: 'HIGH',
        riskScore: 78,
        riskFactors: [
          'Affects Tier-0 critical transaction path',
          'Includes relational database schema alterations (backward compatible)',
          'High customer traffic volume (Est. 4,200 req/sec)'
        ],
        status: 'APPROVED',
        approvalsRequired: 2,
        currentApprovals: [
          {
            role: 'Release Engineering Lead',
            approver: 'Marcus Vance',
            timestamp: '2026-11-20T10:45:00Z',
            comment: 'Verified test reports, lock-free migration scripts, and automated rollback triggers.'
          },
          {
            role: 'Head of SRE Operations',
            approver: 'Devon Reed',
            timestamp: '2026-11-20T11:20:00Z',
            comment: 'On-call notified. Canary rollout schedule approved for 17:30 UTC.'
          }
        ],
        pendingRoles: [],
        createdAt: '2026-11-20T09:30:00Z'
      },
      {
        id: 'cab-4082',
        releaseId: 'rel-2026-11-18-03',
        title: 'v4.1.0 Distributed Sagas Engine Staging Cutover',
        service: 'Order Routing & Orchestration Engine',
        targetEnv: 'staging',
        requestedBy: 'Sarah Jenkins',
        riskLevel: 'MEDIUM',
        riskScore: 54,
        riskFactors: [
          'State machine architectural overhaul',
          'API contract version deprecation'
        ],
        status: 'PENDING',
        approvalsRequired: 1,
        currentApprovals: [],
        pendingRoles: ['QA Architecture Lead'],
        createdAt: '2026-11-20T12:00:00Z'
      }
    ];
    writeJson(APPROVALS_FILE, defaultApprovals);
  }

  // 6. DORA Metrics
  if (!fs.existsSync(DORA_FILE)) {
    const defaultDora = {
      summary: {
        deploymentFrequency: { value: 16.4, unit: 'deploys / week', tier: 'Elite', target: '> 7 / week' },
        leadTimeForChanges: { value: 3.2, unit: 'hours', tier: 'Elite', target: '< 24 hours' },
        changeFailureRate: { value: 1.4, unit: '%', tier: 'Elite', target: '< 5%' },
        meanTimeToRecovery: { value: 12.8, unit: 'minutes', tier: 'Elite', target: '< 60 mins' }
      },
      weeklyTrends: [
        { week: 'W39', deploys: 12, leadTimeHours: 4.8, failureRatePct: 2.1, mttrMins: 18.4 },
        { week: 'W40', deploys: 14, leadTimeHours: 4.2, failureRatePct: 1.8, mttrMins: 15.2 },
        { week: 'W41', deploys: 15, leadTimeHours: 3.9, failureRatePct: 1.9, mttrMins: 14.6 },
        { week: 'W42', deploys: 13, leadTimeHours: 3.6, failureRatePct: 1.5, mttrMins: 13.5 },
        { week: 'W43', deploys: 17, leadTimeHours: 3.4, failureRatePct: 1.2, mttrMins: 12.9 },
        { week: 'W44', deploys: 16, leadTimeHours: 3.2, failureRatePct: 1.4, mttrMins: 12.8 }
      ],
      leadTimeBreakdown: {
        codingTime: '1.2h',
        prReview: '0.8h',
        ciBuildTests: '0.4h',
        stagingSoak: '0.5h',
        productionRollout: '0.3h'
      },
      failureCauses: [
        { cause: 'Unhandled API Edge Case', percentage: 42 },
        { cause: 'Database Connection Pool Exhaustion', percentage: 28 },
        { cause: 'Config Key Mismatch / Drift', percentage: 18 },
        { cause: 'Third-party Gateway Latency Spike', percentage: 12 }
      ]
    };
    writeJson(DORA_FILE, defaultDora);
  }

  // 7. Configs for Drift Auditor
  if (!fs.existsSync(CONFIGS_FILE)) {
    const defaultConfigs = {
      'svc-payments': [
        { key: 'PORT', staging: '8080', 'prod-us': '8080', 'prod-eu': '8080', isSecret: false, status: 'MATCHED' },
        { key: 'DB_POOL_MAX_CONNECTIONS', staging: '25', 'prod-us': '150', 'prod-eu': '120', isSecret: false, status: 'MATCHED' },
        { key: 'STRIPE_API_ENDPOINT', staging: 'https://api.sandbox.stripe.com', 'prod-us': 'https://api.stripe.com', 'prod-eu': 'https://api.stripe.com', isSecret: false, status: 'MATCHED' },
        { key: 'ACQUIRER_TIMEOUT_MS', staging: '2500', 'prod-us': '800', 'prod-eu': '800', isSecret: false, status: 'MATCHED' },
        { key: 'CANARY_TRAFFIC_RATIO', staging: '0.50', 'prod-us': '0.10', 'prod-eu': '0.00', isSecret: false, status: 'DRIFT_DETECTED' },
        { key: 'PAYMENT_HMAC_SECRET', staging: '●●●●●●●● (sha256: 4f1a..)', 'prod-us': '●●●●●●●● (sha256: 9b2c..)', 'prod-eu': '●●●●●●●● (sha256: 9b2c..)', isSecret: true, status: 'SECURE_MATCH' },
        { key: 'ENABLE_BIOMETRIC_3DS', staging: 'true', 'prod-us': 'true', 'prod-eu': 'false', isSecret: false, status: 'DRIFT_DETECTED' },
        { key: 'FEATURE_FALLBACK_ROUTING', staging: 'true', 'prod-us': 'false', 'prod-eu': 'false', isSecret: false, status: 'DRIFT_DETECTED' }
      ],
      'svc-auth': [
        { key: 'JWT_EXPIRATION_SECONDS', staging: '3600', 'prod-us': '900', 'prod-eu': '900', isSecret: false, status: 'MATCHED' },
        { key: 'REDIS_CLUSTER_URL', staging: 'redis://staging-cache.orbit', 'prod-us': 'redis://prod-us-cache.orbit', 'prod-eu': 'redis://prod-eu-cache.orbit', isSecret: false, status: 'MATCHED' },
        { key: 'PRIVATE_KEY_CERT', staging: '●●●●●●●● (sha256: 1a8c..)', 'prod-us': '●●●●●●●● (sha256: 8e4f..)', 'prod-eu': '●●●●●●●● (sha256: 8e4f..)', isSecret: true, status: 'SECURE_MATCH' }
      ]
    };
    writeJson(CONFIGS_FILE, defaultConfigs);
  }

  // 8. Audit Logs
  if (!fs.existsSync(AUDIT_FILE)) {
    const defaultAudit = [
      {
        id: 'aud-1',
        timestamp: '2026-11-20T11:20:00Z',
        action: 'CAB_APPROVAL_GRANTED',
        actor: 'devon.reed@orbitcorp.internal',
        target: 'rel-2026-11-20-01 (v3.4.0)',
        environment: 'prod-us',
        details: 'Approved Change Advisory Board gate for Payment Gateway Bridge',
        status: 'SUCCESS'
      },
      {
        id: 'aud-2',
        timestamp: '2026-11-20T10:45:00Z',
        action: 'CAB_APPROVAL_GRANTED',
        actor: 'marcus.vance@orbitcorp.internal',
        target: 'rel-2026-11-20-01 (v3.4.0)',
        environment: 'prod-us',
        details: 'Approved Change Advisory Board gate for Payment Gateway Bridge',
        status: 'SUCCESS'
      },
      {
        id: 'aud-3',
        timestamp: '2026-11-19T14:18:24Z',
        action: 'DEPLOYMENT_COMPLETED',
        actor: 'marcus.vance@orbitcorp.internal',
        target: 'dep-9821 (svc-auth v2.18.2)',
        environment: 'prod-us',
        details: 'Blue/Green deployment completed successfully without error spikes',
        status: 'SUCCESS'
      }
    ];
    writeJson(AUDIT_FILE, defaultAudit);
  }
}

// ----------------------------------------------------
// DEPLOYMENT ORCHESTRATION ENGINE (Simulation runner)
// ----------------------------------------------------
function executeDeploymentWorkflow(deploymentId) {
  const deployments = readJson(DEPLOYMENTS_FILE, []);
  const dep = deployments.find(d => d.id === deploymentId);
  if (!dep) return;

  const environments = readJson(ENVIRONMENTS_FILE, []);
  const env = environments.find(e => e.id === dep.environment);
  if (env) {
    env.activeDeploymentsCount = (env.activeDeploymentsCount || 0) + 1;
    writeJson(ENVIRONMENTS_FILE, environments);
  }

  logAudit(
    'DEPLOYMENT_TRIGGERED',
    dep.deployedBy,
    `${dep.serviceName} (${dep.version})`,
    dep.environment,
    `Started ${dep.strategy.toUpperCase()} deployment pipeline for ${dep.version}`
  );

  let currentStage = 0;
  const totalStages = dep.stages.length;

  broadcastDeploymentLog(dep.id, `=== [ORBIT-DEPLOY] Initializing Pipeline for ${dep.serviceName} (${dep.version}) ===`, 'INFO', 0);
  broadcastDeploymentLog(dep.id, `Target Environment: ${dep.environment.toUpperCase()} | Strategy: ${dep.strategy.toUpperCase()}`, 'INFO', 0);

  // Interval timer stepping through stages
  const jobInterval = setInterval(() => {
    // Re-check if canceled or rolled back
    const freshDeployments = readJson(DEPLOYMENTS_FILE, []);
    const liveDep = freshDeployments.find(d => d.id === deploymentId);
    if (!liveDep || liveDep.status === 'failed' || liveDep.status === 'rolled_back' || liveDep.status === 'canceled') {
      clearInterval(jobInterval);
      activeDeploymentJobs.delete(deploymentId);
      return;
    }

    if (currentStage < totalStages) {
      const stage = liveDep.stages[currentStage];
      stage.status = 'in_progress';
      liveDep.currentStageIndex = currentStage;
      writeJson(DEPLOYMENTS_FILE, freshDeployments);

      broadcastDeploymentLog(dep.id, `>> Executing Stage [${currentStage + 1}/${totalStages}]: ${stage.name}...`, 'INFO', currentStage);

      // Simulate realistic stage actions
      if (currentStage === 0) {
        broadcastDeploymentLog(dep.id, `Checking cluster resource quotas in namespace: ${dep.environment}... OK`, 'INFO', currentStage);
        broadcastDeploymentLog(dep.id, `Validating IAM RBAC credentials and deployment freeze bypass token... OK`, 'INFO', currentStage);
      } else if (currentStage === 1) {
        broadcastDeploymentLog(dep.id, `Verifying container signature with Cosign KMS root-of-trust... OK`, 'INFO', currentStage);
        broadcastDeploymentLog(dep.id, `Running SBOM vulnerability scan (Snyk/Trivy): 0 Critical, 0 High vulnerabilities... PASSED`, 'SUCCESS', currentStage);
      } else if (currentStage === 2) {
        broadcastDeploymentLog(dep.id, `Checking database migration dry-run scripts... Lock-free DDL verified.`, 'INFO', currentStage);
        broadcastDeploymentLog(dep.id, `Applying schema changes with zero-lock transactional DDL... OK`, 'SUCCESS', currentStage);
      } else if (currentStage === 3) {
        const canaryPct = dep.strategy === 'canary' ? 10 : (dep.strategy === 'blue-green' ? 50 : 25);
        liveDep.canaryTrafficPercent = canaryPct;
        broadcastDeploymentLog(dep.id, `Traffic weight adjusted: routing ${canaryPct}% live traffic to target pods.`, 'WARN', currentStage);
        broadcastDeploymentLog(dep.id, `Running synthetic probes against /healthz and /readyz endpoints... All 16 replicas READY.`, 'INFO', currentStage);
      } else if (currentStage === 4) {
        const nextPct = dep.strategy === 'canary' ? 50 : (dep.strategy === 'blue-green' ? 100 : 75);
        liveDep.canaryTrafficPercent = nextPct;
        broadcastDeploymentLog(dep.id, `Canary gate analysis: Error rate = 0.008% (Threshold < 0.2%), P99 Latency = 82ms (Baseline 86ms).`, 'SUCCESS', currentStage);
        broadcastDeploymentLog(dep.id, `Canary gate PASSED. Promoting traffic to ${nextPct}%.`, 'INFO', currentStage);
      } else if (currentStage === 5) {
        liveDep.canaryTrafficPercent = 100;
        broadcastDeploymentLog(dep.id, `Completing full cutover: 100% traffic routed to version ${dep.version}.`, 'SUCCESS', currentStage);
        broadcastDeploymentLog(dep.id, `Draining previous pod generation gracefully (connection draining timeout: 30s)... OK`, 'INFO', currentStage);
      } else {
        broadcastDeploymentLog(dep.id, `Executing post-deployment synthetic end-to-end smoke verification... 100% checks PASSED.`, 'SUCCESS', currentStage);
        broadcastDeploymentLog(dep.id, `Slack, Microsoft Teams, and PagerDuty deployment notifications dispatched.`, 'INFO', currentStage);
      }

      stage.status = 'completed';
      writeJson(DEPLOYMENTS_FILE, freshDeployments);
      currentStage++;
    } else {
      // Completed all stages!
      clearInterval(jobInterval);
      activeDeploymentJobs.delete(deploymentId);

      liveDep.status = 'success';
      liveDep.completedAt = new Date().toISOString();
      liveDep.duration = '2m 15s';
      liveDep.canaryTrafficPercent = 100;
      writeJson(DEPLOYMENTS_FILE, freshDeployments);

      // Update Service version in environment
      const services = readJson(SERVICES_FILE, []);
      const service = services.find(s => s.id === liveDep.serviceId);
      if (service) {
        service.currentVersions = service.currentVersions || {};
        service.currentVersions[liveDep.environment] = liveDep.version;
        writeJson(SERVICES_FILE, services);
      }

      // Update Release status
      const releases = readJson(RELEASES_FILE, []);
      const rel = releases.find(r => r.id === liveDep.releaseId);
      if (rel) {
        rel.status = 'released';
        writeJson(RELEASES_FILE, releases);
      }

      // Decrement active deployment count
      const updatedEnvs = readJson(ENVIRONMENTS_FILE, []);
      const targetEnv = updatedEnvs.find(e => e.id === liveDep.environment);
      if (targetEnv) {
        targetEnv.activeDeploymentsCount = Math.max(0, (targetEnv.activeDeploymentsCount || 1) - 1);
        writeJson(ENVIRONMENTS_FILE, updatedEnvs);
      }

      // Update DORA deployment count
      const dora = readJson(DORA_FILE, {});
      if (dora.summary && dora.summary.deploymentFrequency) {
        dora.summary.deploymentFrequency.value = +(dora.summary.deploymentFrequency.value + 0.1).toFixed(1);
        writeJson(DORA_FILE, dora);
      }

      broadcastDeploymentLog(dep.id, `=== [ORBIT-DEPLOY] Deployment ${dep.id} COMPLETED SUCCESSFULLY! ===`, 'SUCCESS');
      broadcastDeploymentUpdate(dep.id, { status: 'success', canaryTrafficPercent: 100 });

      logAudit(
        'DEPLOYMENT_COMPLETED',
        liveDep.deployedBy,
        `${liveDep.serviceName} (${liveDep.version})`,
        liveDep.environment,
        `Pipeline completed successfully. All traffic shifted to ${liveDep.version}`
      );
    }
  }, 1800);

  activeDeploymentJobs.set(deploymentId, jobInterval);
}

// Rollback Engine
function triggerRollback(originalDeploymentId, actor = 'oncall.sre@orbitcorp.internal', reason = 'Elevated 5xx error rate detected') {
  const deployments = readJson(DEPLOYMENTS_FILE, []);
  const dep = deployments.find(d => d.id === originalDeploymentId);
  if (!dep) return null;

  // Stop any running job
  if (activeDeploymentJobs.has(originalDeploymentId)) {
    clearInterval(activeDeploymentJobs.get(originalDeploymentId));
    activeDeploymentJobs.delete(originalDeploymentId);
  }

  dep.status = 'rolled_back';
  broadcastDeploymentLog(dep.id, `!!! [CIRCUIT BREAKER] ROLLBACK TRIGGERED: ${reason} !!!`, 'ERROR');
  broadcastDeploymentLog(dep.id, `Draining traffic from ${dep.version} and reverting to stable baseline ${dep.previousVersion}...`, 'WARN');

  // Create explicit rollback deployment record
  const rollbackDep = {
    id: `dep-rb-${Date.now()}`,
    releaseId: dep.releaseId,
    serviceId: dep.serviceId,
    serviceName: dep.serviceName,
    version: dep.previousVersion,
    previousVersion: dep.version,
    environment: dep.environment,
    strategy: 'instant_rollback',
    status: 'success',
    startedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 12000).toISOString(),
    duration: '12s (Instant)',
    deployedBy: actor,
    canaryTrafficPercent: 100,
    currentStageIndex: 2,
    stages: [
      { name: 'Circuit Breaker Ingress Cutback', status: 'completed', duration: '2s' },
      { name: 'Restore Previous Replica Weights', status: 'completed', duration: '4s' },
      { name: 'Revert Database Read Replicas & Cache Invalidation', status: 'completed', duration: '6s' }
    ],
    logs: [
      { timestamp: new Date().toISOString(), level: 'ERROR', message: `Emergency rollback initiated: ${reason}` },
      { timestamp: new Date(Date.now() + 2000).toISOString(), level: 'WARN', message: `Shifted 100% traffic back to previous image: ${dep.previousVersion}` },
      { timestamp: new Date(Date.now() + 8000).toISOString(), level: 'INFO', message: `Health probes verified on ${dep.previousVersion}. Error rates restored to 0.00%` }
    ],
    metricsSnapshot: { errorRate: '0.00%', p99Latency: '78ms', cpuUtil: '44%' }
  };

  deployments.unshift(rollbackDep);
  writeJson(DEPLOYMENTS_FILE, deployments);

  // Restore service version in environment
  const services = readJson(SERVICES_FILE, []);
  const service = services.find(s => s.id === dep.serviceId);
  if (service) {
    service.currentVersions = service.currentVersions || {};
    service.currentVersions[dep.environment] = dep.previousVersion;
    writeJson(SERVICES_FILE, services);
  }

  // Update original release status
  const releases = readJson(RELEASES_FILE, []);
  const rel = releases.find(r => r.id === dep.releaseId);
  if (rel) {
    rel.status = 'rolled_back';
    writeJson(RELEASES_FILE, releases);
  }

  // Update DORA metrics (increments MTTR and CFR)
  const dora = readJson(DORA_FILE, {});
  if (dora.summary && dora.summary.changeFailureRate) {
    dora.summary.changeFailureRate.value = +(dora.summary.changeFailureRate.value + 0.2).toFixed(1);
    writeJson(DORA_FILE, dora);
  }

  logAudit(
    'ROLLBACK_EXECUTED',
    actor,
    `${dep.serviceName} (${dep.version} -> ${dep.previousVersion})`,
    dep.environment,
    `Emergency rollback triggered: ${reason}`,
    'WARNING'
  );

  broadcastDeploymentUpdate(dep.id, { status: 'rolled_back', canaryTrafficPercent: 0 });

  return rollbackDep;
}

// ----------------------------------------------------
// DYNAMIC RISK ASSESSMENT ENGINE
// ----------------------------------------------------
function calculateReleaseRisk(releaseData) {
  let score = 10;
  const factors = [];

  // Service Tier
  if (releaseData.serviceTier && releaseData.serviceTier.includes('Tier-0')) {
    score += 35;
    factors.push('Service is designated Tier-0 Mission Critical (+35)');
  } else if (releaseData.serviceTier && releaseData.serviceTier.includes('Tier-1')) {
    score += 20;
    factors.push('Service is Tier-1 High Impact (+20)');
  }

  // Release Type
  if (releaseData.releaseType === 'major') {
    score += 30;
    factors.push('Major SemVer version bump (+30)');
  } else if (releaseData.releaseType === 'minor') {
    score += 15;
    factors.push('Minor feature expansion (+15)');
  } else if (releaseData.releaseType === 'hotfix') {
    score += 25;
    factors.push('Emergency hotfix fast-track (+25)');
  }

  // Database migrations
  if (releaseData.hasDbMigration) {
    score += 20;
    factors.push('Includes relational database schema alterations (+20)');
  }

  // Target Environment
  if (releaseData.targetEnvironment && releaseData.targetEnvironment.startsWith('prod')) {
    score += 20;
    factors.push('Targeting live Production cluster (+20)');
  }

  // Friday deployment penalty!
  const today = new Date().getDay(); // 5 = Friday
  if (today === 5) {
    score += 15;
    factors.push('Friday deployment window risk modifier (+15)');
  }

  score = Math.min(100, Math.max(5, score));
  let level = 'LOW';
  if (score >= 70) level = 'CRITICAL';
  else if (score >= 50) level = 'HIGH';
  else if (score >= 30) level = 'MEDIUM';

  return { score, level, factors };
}

// Initialize seed data on startup
seedInitialData();

// ----------------------------------------------------
// HTTP SERVER & ROUTER
// ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // URL parsing
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  try {
    // ----------------------------------------------------
    // 1. HEALTH & OVERVIEW
    // ----------------------------------------------------
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'healthy',
        uptime: process.uptime(),
        nodeVersion: process.version,
        activeDeployments: activeDeploymentJobs.size,
        timestamp: new Date().toISOString()
      });
    }

    if (pathname === '/api/overview' && req.method === 'GET') {
      const releases = readJson(RELEASES_FILE, []);
      const deployments = readJson(DEPLOYMENTS_FILE, []);
      const environments = readJson(ENVIRONMENTS_FILE, []);
      const services = readJson(SERVICES_FILE, []);
      const approvals = readJson(APPROVALS_FILE, []);
      const dora = readJson(DORA_FILE, {});
      const audit = readJson(AUDIT_FILE, []).slice(0, 10);

      const activeDeployments = deployments.filter(d => d.status === 'in_progress');
      const pendingApprovals = approvals.filter(a => a.status === 'PENDING');
      const frozenEnvironments = environments.filter(e => e.isFrozen);

      return sendJson(res, 200, {
        totalReleases: releases.length,
        totalServices: services.length,
        totalEnvironments: environments.length,
        activeDeploymentsCount: activeDeployments.length,
        pendingApprovalsCount: pendingApprovals.length,
        frozenEnvironmentsCount: frozenEnvironments.length,
        doraSummary: dora.summary || {},
        environments,
        recentDeployments: deployments.slice(0, 5),
        recentAuditLogs: audit,
        activeDeployments
      });
    }

    // ----------------------------------------------------
    // 2. RELEASES API
    // ----------------------------------------------------
    if (pathname === '/api/releases' && req.method === 'GET') {
      let releases = readJson(RELEASES_FILE, []);
      if (query.status) {
        releases = releases.filter(r => r.status.toLowerCase() === query.status.toLowerCase());
      }
      if (query.serviceId) {
        releases = releases.filter(r => r.serviceId === query.serviceId);
      }
      if (query.environment) {
        releases = releases.filter(r => r.targetEnvironment === query.environment);
      }
      if (query.q) {
        const q = query.q.toLowerCase();
        releases = releases.filter(r => 
          r.version.toLowerCase().includes(q) ||
          r.title.toLowerCase().includes(q) ||
          r.serviceName.toLowerCase().includes(q)
        );
      }
      return sendJson(res, 200, releases);
    }

    // GET /api/releases/:id
    const singleReleaseMatch = pathname.match(/^\/api\/releases\/([a-zA-Z0-9_-]+)$/);
    if (singleReleaseMatch && req.method === 'GET') {
      const releaseId = singleReleaseMatch[1];
      const releases = readJson(RELEASES_FILE, []);
      const rel = releases.find(r => r.id === releaseId);
      if (!rel) return sendJson(res, 404, { error: 'Release not found' });
      return sendJson(res, 200, rel);
    }

    // POST /api/releases - Create New Release Plan
    if (pathname === '/api/releases' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      if (!body.version || !body.title || !body.serviceId) {
        return sendJson(res, 400, { error: 'version, title, and serviceId are required' });
      }

      const services = readJson(SERVICES_FILE, []);
      const service = services.find(s => s.id === body.serviceId) || { name: body.serviceId, tier: 'Tier-1' };

      const riskCalc = calculateReleaseRisk({
        serviceTier: service.tier,
        releaseType: body.releaseType || 'minor',
        hasDbMigration: !!(body.databaseMigrations && body.databaseMigrations.length > 0),
        targetEnvironment: body.targetEnvironment || 'prod-us'
      });

      const newRelease = {
        id: `rel-${Date.now()}`,
        version: body.version.trim(),
        title: body.title.trim(),
        serviceId: body.serviceId,
        serviceName: service.name,
        status: body.status || 'in_review',
        releaseType: body.releaseType || 'minor',
        riskLevel: riskCalc.level.toLowerCase(),
        riskScore: riskCalc.score,
        targetEnvironment: body.targetEnvironment || 'prod-us',
        author: body.author || 'Engineering Team',
        authorEmail: body.authorEmail || 'dev@orbitcorp.internal',
        scheduledDate: body.scheduledDate || new Date().toISOString(),
        cabStatus: riskCalc.level === 'LOW' ? 'approved' : 'pending',
        commitsCount: body.commitsCount || (body.pullRequests ? body.pullRequests.length * 4 : 5),
        pullRequests: body.pullRequests || [
          { id: `#${Math.floor(Math.random() * 800 + 1000)}`, title: body.title, author: body.author || 'dev', mergeDate: new Date().toISOString().split('T')[0] }
        ],
        releaseNotes: {
          highlights: body.highlights || `Production release for ${service.name} ${body.version}`,
          features: body.features || ['Core functional stability and performance improvements.'],
          bugFixes: body.bugFixes || [],
          breakingChanges: body.breakingChanges || [],
          databaseMigrations: body.databaseMigrations || []
        },
        checks: {
          sastScan: { status: 'passed', score: '0 Critical / 0 High', tool: 'Snyk & SonarQube' },
          e2eTests: { status: 'passed', passed: 412, failed: 0, duration: '2m 48s' },
          perfBaseline: { status: 'passed', p99Diff: '-14ms', baselineP99: '82ms' },
          dbMigrationDryRun: { status: body.databaseMigrations && body.databaseMigrations.length ? 'passed' : 'skipped', duration: '1.1s' },
          containerSignature: { status: 'passed', verified: true, signer: 'Cosign' }
        },
        createdAt: new Date().toISOString()
      };

      const releases = readJson(RELEASES_FILE, []);
      releases.unshift(newRelease);
      writeJson(RELEASES_FILE, releases);

      // If CAB approval is needed, auto-create CAB entry
      if (newRelease.cabStatus === 'pending') {
        const approvals = readJson(APPROVALS_FILE, []);
        const newCab = {
          id: `cab-${Date.now()}`,
          releaseId: newRelease.id,
          title: `${newRelease.version} Deployment to ${newRelease.targetEnvironment.toUpperCase()}`,
          service: newRelease.serviceName,
          targetEnv: newRelease.targetEnvironment,
          requestedBy: newRelease.author,
          riskLevel: riskCalc.level,
          riskScore: riskCalc.score,
          riskFactors: riskCalc.factors,
          status: 'PENDING',
          approvalsRequired: riskCalc.level === 'CRITICAL' ? 2 : 1,
          currentApprovals: [],
          pendingRoles: riskCalc.level === 'CRITICAL' ? ['Release Engineering Lead', 'Security Officer'] : ['Release Engineering Lead'],
          createdAt: new Date().toISOString()
        };
        approvals.unshift(newCab);
        writeJson(APPROVALS_FILE, approvals);
        newRelease.cabApprovalId = newCab.id;
        writeJson(RELEASES_FILE, releases);
      }

      logAudit(
        'RELEASE_CREATED',
        newRelease.author,
        `${newRelease.serviceName} (${newRelease.version})`,
        newRelease.targetEnvironment,
        `Created release plan. Risk assessment: ${riskCalc.level} (Score: ${riskCalc.score})`
      );

      return sendJson(res, 201, newRelease);
    }

    // PUT /api/releases/:id
    if (singleReleaseMatch && req.method === 'PUT') {
      const releaseId = singleReleaseMatch[1];
      const body = await parseRequestBody(req);
      const releases = readJson(RELEASES_FILE, []);
      const index = releases.findIndex(r => r.id === releaseId);
      if (index === -1) return sendJson(res, 404, { error: 'Release not found' });

      releases[index] = { ...releases[index], ...body, updatedAt: new Date().toISOString() };
      writeJson(RELEASES_FILE, releases);

      logAudit(
        'RELEASE_UPDATED',
        body.updatedBy || 'system',
        `${releases[index].serviceName} (${releases[index].version})`,
        releases[index].targetEnvironment,
        `Updated release metadata and status to ${releases[index].status}`
      );

      return sendJson(res, 200, releases[index]);
    }

    // POST /api/releases/:id/generate-notes - Automated Release Notes Generator
    const notesMatch = pathname.match(/^\/api\/releases\/([a-zA-Z0-9_-]+)\/generate-notes$/);
    if (notesMatch && req.method === 'POST') {
      const releaseId = notesMatch[1];
      const releases = readJson(RELEASES_FILE, []);
      const rel = releases.find(r => r.id === releaseId);
      if (!rel) return sendJson(res, 404, { error: 'Release not found' });

      // Generate rich markdown & HTML
      const mdNotes = [
        `# Release Notes: ${rel.serviceName} - ${rel.version}: ${rel.title}`,
        `**Release Date:** ${new Date().toISOString().split('T')[0]}  `,
        `**Release Lead:** ${rel.author}  `,
        `**Target Environment:** \`${rel.targetEnvironment}\`  `,
        `**Risk Assessment:** ${rel.riskLevel ? rel.riskLevel.toUpperCase() : 'MEDIUM'}  `,
        ``,
        `## 🌟 Executive Summary`,
        `${rel.releaseNotes.highlights || 'Production enhancements and stability rollout.'}`,
        ``,
        `## 🚀 Key Features & Enhancements`,
        ...(rel.releaseNotes.features || []).map(f => `- ${f}`),
        ``,
        `## 🐛 Bug Fixes & Mitigations`,
        ...(rel.releaseNotes.bugFixes && rel.releaseNotes.bugFixes.length ? rel.releaseNotes.bugFixes.map(b => `- ${b}`) : ['- No critical bugs reported.']),
        ``,
        `## ⚠️ Breaking Changes & Deprecations`,
        ...(rel.releaseNotes.breakingChanges && rel.releaseNotes.breakingChanges.length ? rel.releaseNotes.breakingChanges.map(c => `- ⚠️ ${c}`) : ['- None (100% backward compatible)']),
        ``,
        `## 🗄️ Database Migrations`,
        ...(rel.releaseNotes.databaseMigrations && rel.releaseNotes.databaseMigrations.length ? rel.releaseNotes.databaseMigrations.map(m => `- \`${m}\``) : ['- No database schema alterations required.']),
        ``,
        `## 🛡️ Pre-Flight Verification Gates`,
        `- **SAST / Dependency Scan:** ${rel.checks?.sastScan?.status || 'passed'} (${rel.checks?.sastScan?.score || '0 Critical'})`,
        `- **Automated Tests:** ${rel.checks?.e2eTests?.passed || 400}+ passed (${rel.checks?.e2eTests?.duration || '3m'})`,
        `- **Cosign Image Signature:** Verified KMS digest`
      ].join('\n');

      return sendJson(res, 200, { markdown: mdNotes, release: rel });
    }

    // ----------------------------------------------------
    // 3. DEPLOYMENTS API & ENGINE
    // ----------------------------------------------------
    if (pathname === '/api/deployments' && req.method === 'GET') {
      let deployments = readJson(DEPLOYMENTS_FILE, []);
      if (query.environment) {
        deployments = deployments.filter(d => d.environment === query.environment);
      }
      if (query.serviceId) {
        deployments = deployments.filter(d => d.serviceId === query.serviceId);
      }
      if (query.status) {
        deployments = deployments.filter(d => d.status === query.status);
      }
      return sendJson(res, 200, deployments);
    }

    // GET /api/deployments/:id
    const singleDepMatch = pathname.match(/^\/api\/deployments\/([a-zA-Z0-9_-]+)$/);
    if (singleDepMatch && req.method === 'GET') {
      const depId = singleDepMatch[1];
      const deployments = readJson(DEPLOYMENTS_FILE, []);
      const dep = deployments.find(d => d.id === depId);
      if (!dep) return sendJson(res, 404, { error: 'Deployment not found' });
      return sendJson(res, 200, dep);
    }

    // POST /api/deployments - Trigger Deployment
    if (pathname === '/api/deployments' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      if (!body.serviceId || !body.version || !body.environment) {
        return sendJson(res, 400, { error: 'serviceId, version, and environment are required' });
      }

      // Check environment freeze
      const environments = readJson(ENVIRONMENTS_FILE, []);
      const targetEnv = environments.find(e => e.id === body.environment);
      if (targetEnv && targetEnv.isFrozen && !body.bypassFreeze) {
        return sendJson(res, 403, {
          error: `Environment ${targetEnv.name} is currently FROZEN: "${targetEnv.freezeReason}". Deployment blocked. Provide emergency bypass authorization to proceed.`
        });
      }

      // Check if another deployment is currently active on this service in this environment
      const existingDeployments = readJson(DEPLOYMENTS_FILE, []);
      const alreadyRunning = existingDeployments.some(d => 
        d.serviceId === body.serviceId && 
        d.environment === body.environment && 
        d.status === 'in_progress'
      );
      if (alreadyRunning) {
        return sendJson(res, 409, { error: `A deployment is already running for ${body.serviceId} in ${body.environment}. Please wait or cancel it.` });
      }

      const services = readJson(SERVICES_FILE, []);
      const service = services.find(s => s.id === body.serviceId) || { name: body.serviceId, defaultStrategy: 'canary' };
      const previousVersion = (service.currentVersions && service.currentVersions[body.environment]) || 'v1.0.0';

      const strategy = body.strategy || service.defaultStrategy || 'canary';

      // Define standard pipeline stages based on strategy
      const stages = [
        { name: 'Pre-flight & Cluster Quota Verification', status: 'pending', duration: '15s' },
        { name: 'Cosign Artifact Signature & SBOM Scan', status: 'pending', duration: '20s' },
        { name: 'Zero-downtime DB Migration Dry-run', status: 'pending', duration: '40s' },
        { name: strategy === 'canary' ? 'Canary Rollout (10% Traffic)' : (strategy === 'blue-green' ? 'Spin up Green Pod Fleet' : 'Rolling Pod Batch 1'), status: 'pending', duration: '2m' },
        { name: 'Automated SLI/SLO Canary Health Analysis', status: 'pending', duration: '2m 30s' },
        { name: strategy === 'blue-green' ? 'Ingress Router Switch (100% to Green)' : 'Promote Full Traffic Cutover (100%)', status: 'pending', duration: '1m 45s' },
        { name: 'Post-deploy Synthetic Verification & Smoke Tests', status: 'pending', duration: '30s' }
      ];

      const newDeployment = {
        id: `dep-${Date.now()}`,
        releaseId: body.releaseId || `rel-adhoc-${Date.now()}`,
        serviceId: body.serviceId,
        serviceName: service.name,
        version: body.version.trim(),
        previousVersion,
        environment: body.environment,
        strategy,
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        completedAt: null,
        duration: 'In progress...',
        deployedBy: body.deployedBy || 'Elena Rostova (Lead SRE)',
        canaryTrafficPercent: 0,
        currentStageIndex: 0,
        stages,
        logs: [
          { timestamp: new Date().toISOString(), level: 'INFO', message: `Deployment triggered for ${service.name} (${body.version}) to ${body.environment}` }
        ],
        metricsSnapshot: { errorRate: '0.00%', p99Latency: '82ms', cpuUtil: '48%' }
      };

      existingDeployments.unshift(newDeployment);
      writeJson(DEPLOYMENTS_FILE, existingDeployments);

      // Start asynchronous progression loop
      executeDeploymentWorkflow(newDeployment.id);

      return sendJson(res, 201, newDeployment);
    }

    // POST /api/deployments/:id/rollback - Instant Rollback
    const rollbackMatch = pathname.match(/^\/api\/deployments\/([a-zA-Z0-9_-]+)\/rollback$/);
    if (rollbackMatch && req.method === 'POST') {
      const depId = rollbackMatch[1];
      const body = await parseRequestBody(req);
      const rollbackDep = triggerRollback(
        depId,
        body.actor || 'oncall.sre@orbitcorp.internal',
        body.reason || 'Manual emergency circuit breaker triggered'
      );
      if (!rollbackDep) {
        return sendJson(res, 404, { error: 'Deployment not found' });
      }
      return sendJson(res, 200, { success: true, rollbackDeployment: rollbackDep });
    }

    // POST /api/deployments/:id/canary-traffic - Adjust canary traffic manually
    const canaryTrafficMatch = pathname.match(/^\/api\/deployments\/([a-zA-Z0-9_-]+)\/canary-traffic$/);
    if (canaryTrafficMatch && req.method === 'POST') {
      const depId = canaryTrafficMatch[1];
      const body = await parseRequestBody(req);
      const targetPercent = parseInt(body.percent, 10);
      if (isNaN(targetPercent) || targetPercent < 0 || targetPercent > 100) {
        return sendJson(res, 400, { error: 'percent must be a number between 0 and 100' });
      }

      const deployments = readJson(DEPLOYMENTS_FILE, []);
      const dep = deployments.find(d => d.id === depId);
      if (!dep) return sendJson(res, 404, { error: 'Deployment not found' });

      dep.canaryTrafficPercent = targetPercent;
      writeJson(DEPLOYMENTS_FILE, deployments);

      broadcastDeploymentLog(dep.id, `Manual override: Canary traffic weight set to ${targetPercent}% by ${body.actor || 'operator'}`, 'WARN');
      broadcastDeploymentUpdate(dep.id, { canaryTrafficPercent: targetPercent });

      logAudit(
        'CANARY_TRAFFIC_ADJUSTED',
        body.actor || 'operator',
        `${dep.serviceName} (${dep.version})`,
        dep.environment,
        `Shifted canary traffic weight to ${targetPercent}%`
      );

      return sendJson(res, 200, { success: true, canaryTrafficPercent: targetPercent });
    }

    // SSE: GET /api/deployments/:id/events - Live Streaming Logs & Telemetry
    const sseMatch = pathname.match(/^\/api\/deployments\/([a-zA-Z0-9_-]+)\/events$/);
    if (sseMatch && req.method === 'GET') {
      const depId = sseMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      if (!deploymentSseClients.has(depId)) {
        deploymentSseClients.set(depId, new Set());
      }
      deploymentSseClients.get(depId).add(res);

      // Send initial snapshot
      const deployments = readJson(DEPLOYMENTS_FILE, []);
      const dep = deployments.find(d => d.id === depId);
      if (dep) {
        res.write(`data: ${JSON.stringify({ type: 'init', deployment: dep })}\n\n`);
      }

      req.on('close', () => {
        const clientSet = deploymentSseClients.get(depId);
        if (clientSet) {
          clientSet.delete(res);
          if (clientSet.size === 0) deploymentSseClients.delete(depId);
        }
      });
      return;
    }

    // ----------------------------------------------------
    // 4. ENVIRONMENTS & FLEET MATRIX
    // ----------------------------------------------------
    if (pathname === '/api/environments' && req.method === 'GET') {
      const environments = readJson(ENVIRONMENTS_FILE, []);
      const services = readJson(SERVICES_FILE, []);

      // Calculate version drift across environments
      const matrix = services.map(svc => {
        return {
          serviceId: svc.id,
          serviceName: svc.name,
          tier: svc.tier,
          versions: svc.currentVersions || {}
        };
      });

      return sendJson(res, 200, { environments, matrix });
    }

    // POST /api/environments/:id/freeze - Toggle Freeze Lock
    const freezeMatch = pathname.match(/^\/api\/environments\/([a-zA-Z0-9_-]+)\/freeze$/);
    if (freezeMatch && req.method === 'POST') {
      const envId = freezeMatch[1];
      const body = await parseRequestBody(req);
      const environments = readJson(ENVIRONMENTS_FILE, []);
      const env = environments.find(e => e.id === envId);
      if (!env) return sendJson(res, 404, { error: 'Environment not found' });

      env.isFrozen = body.isFrozen !== undefined ? body.isFrozen : !env.isFrozen;
      env.freezeReason = env.isFrozen ? (body.reason || 'Scheduled Maintenance & Freeze Window') : '';
      env.frozenBy = env.isFrozen ? (body.actor || 'Release Commander') : '';
      writeJson(ENVIRONMENTS_FILE, environments);

      logAudit(
        env.isFrozen ? 'ENVIRONMENT_FROZEN' : 'ENVIRONMENT_UNFROZEN',
        body.actor || 'Release Commander',
        env.name,
        env.id,
        env.isFrozen ? `Locked environment with reason: "${env.freezeReason}"` : 'Unlocked environment for deployments',
        env.isFrozen ? 'WARNING' : 'SUCCESS'
      );

      return sendJson(res, 200, { success: true, environment: env });
    }

    // ----------------------------------------------------
    // 5. SERVICES CATALOG & DEPENDENCIES
    // ----------------------------------------------------
    if (pathname === '/api/services' && req.method === 'GET') {
      const services = readJson(SERVICES_FILE, []);
      return sendJson(res, 200, services);
    }

    // POST /api/services - Register New Service
    if (pathname === '/api/services' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      if (!body.name || !body.slug) {
        return sendJson(res, 400, { error: 'name and slug are required' });
      }

      const services = readJson(SERVICES_FILE, []);
      const newService = {
        id: `svc-${Date.now()}`,
        name: body.name.trim(),
        slug: body.slug.trim(),
        tier: body.tier || 'Tier-1 (High Impact)',
        team: body.team || 'Platform Engineering',
        lead: body.lead || 'Engineering Manager',
        repo: body.repo || `github.com/orbitcorp/${body.slug}`,
        language: body.language || 'TypeScript / Node.js 22',
        defaultStrategy: body.defaultStrategy || 'canary',
        dependencies: body.dependencies || [],
        currentVersions: {
          dev: 'v1.0.0-rc1',
          qa: 'v1.0.0',
          staging: 'v1.0.0',
          canary: 'v1.0.0',
          'prod-us': 'v1.0.0',
          'prod-eu': 'v1.0.0'
        }
      };

      services.push(newService);
      writeJson(SERVICES_FILE, services);

      logAudit('SERVICE_REGISTERED', body.actor || 'admin', newService.name, 'GLOBAL', `Registered service ${newService.slug}`);
      return sendJson(res, 201, newService);
    }

    // ----------------------------------------------------
    // 6. CAB APPROVALS & GOVERNANCE
    // ----------------------------------------------------
    if (pathname === '/api/approvals' && req.method === 'GET') {
      const approvals = readJson(APPROVALS_FILE, []);
      return sendJson(res, 200, approvals);
    }

    // POST /api/approvals/:id/approve
    const approveMatch = pathname.match(/^\/api\/approvals\/([a-zA-Z0-9_-]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      const approvalId = approveMatch[1];
      const body = await parseRequestBody(req);
      const approvals = readJson(APPROVALS_FILE, []);
      const item = approvals.find(a => a.id === approvalId);
      if (!item) return sendJson(res, 404, { error: 'Approval request not found' });

      item.currentApprovals = item.currentApprovals || [];
      item.currentApprovals.push({
        role: body.role || 'Release Engineering Lead',
        approver: body.approver || 'Marcus Vance',
        timestamp: new Date().toISOString(),
        comment: body.comment || 'Approved after pre-flight audit review.'
      });

      if (item.currentApprovals.length >= item.approvalsRequired) {
        item.status = 'APPROVED';
        item.pendingRoles = [];

        // Also update associated release if linked
        if (item.releaseId) {
          const releases = readJson(RELEASES_FILE, []);
          const rel = releases.find(r => r.id === item.releaseId);
          if (rel) {
            rel.cabStatus = 'approved';
            rel.status = 'approved';
            writeJson(RELEASES_FILE, releases);
          }
        }
      }

      writeJson(APPROVALS_FILE, approvals);

      logAudit(
        'CAB_APPROVAL_GRANTED',
        body.approver || 'CAB Member',
        item.title,
        item.targetEnv,
        `Approved CAB request. Status now: ${item.status}`
      );

      return sendJson(res, 200, { success: true, approval: item });
    }

    // POST /api/approvals/:id/reject
    const rejectMatch = pathname.match(/^\/api\/approvals\/([a-zA-Z0-9_-]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      const approvalId = rejectMatch[1];
      const body = await parseRequestBody(req);
      const approvals = readJson(APPROVALS_FILE, []);
      const item = approvals.find(a => a.id === approvalId);
      if (!item) return sendJson(res, 404, { error: 'Approval request not found' });

      item.status = 'REJECTED';
      item.rejectionReason = body.reason || 'Pre-flight risk assessment thresholds not met';
      item.rejectedBy = body.approver || 'CAB Reviewer';
      item.rejectedAt = new Date().toISOString();
      writeJson(APPROVALS_FILE, approvals);

      if (item.releaseId) {
        const releases = readJson(RELEASES_FILE, []);
        const rel = releases.find(r => r.id === item.releaseId);
        if (rel) {
          rel.cabStatus = 'rejected';
          writeJson(RELEASES_FILE, releases);
        }
      }

      logAudit(
        'CAB_APPROVAL_REJECTED',
        body.approver || 'CAB Member',
        item.title,
        item.targetEnv,
        `Rejected release: ${item.rejectionReason}`,
        'WARNING'
      );

      return sendJson(res, 200, { success: true, approval: item });
    }

    // ----------------------------------------------------
    // 7. CONFIG & SECRET DRIFT AUDITOR
    // ----------------------------------------------------
    if (pathname === '/api/configs/diff' && req.method === 'GET') {
      const serviceId = query.serviceId || 'svc-payments';
      const envA = query.envA || 'staging';
      const envB = query.envB || 'prod-us';

      const configs = readJson(CONFIGS_FILE, {});
      const vars = configs[serviceId] || [];

      const comparison = vars.map(v => {
        const valA = v[envA] !== undefined ? v[envA] : '(not defined)';
        const valB = v[envB] !== undefined ? v[envB] : '(not defined)';
        const isMatched = valA === valB;

        let status = 'MATCHED';
        if (v.isSecret) {
          status = 'SECURE_MATCH';
        } else if (!isMatched) {
          status = 'DRIFT_DETECTED';
        }

        return {
          key: v.key,
          isSecret: v.isSecret,
          envA: { name: envA, value: valA },
          envB: { name: envB, value: valB },
          status
        };
      });

      return sendJson(res, 200, {
        serviceId,
        envA,
        envB,
        totalVariables: comparison.length,
        driftsCount: comparison.filter(c => c.status === 'DRIFT_DETECTED').length,
        comparison
      });
    }

    // ----------------------------------------------------
    // 8. DORA & PERFORMANCE ANALYTICS
    // ----------------------------------------------------
    if (pathname === '/api/dora' && req.method === 'GET') {
      const dora = readJson(DORA_FILE, {});
      return sendJson(res, 200, dora);
    }

    // ----------------------------------------------------
    // 9. AUDIT LOGS & BACKUP/RESTORE
    // ----------------------------------------------------
    if (pathname === '/api/audit-logs' && req.method === 'GET') {
      let logs = readJson(AUDIT_FILE, []);
      if (query.action) {
        logs = logs.filter(l => l.action.toLowerCase() === query.action.toLowerCase());
      }
      if (query.q) {
        const q = query.q.toLowerCase();
        logs = logs.filter(l => 
          l.action.toLowerCase().includes(q) || 
          l.actor.toLowerCase().includes(q) || 
          l.target.toLowerCase().includes(q) ||
          l.details.toLowerCase().includes(q)
        );
      }
      return sendJson(res, 200, logs);
    }

    // GET /api/export
    if (pathname === '/api/export' && req.method === 'GET') {
      const backup = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        releases: readJson(RELEASES_FILE, []),
        deployments: readJson(DEPLOYMENTS_FILE, []),
        environments: readJson(ENVIRONMENTS_FILE, []),
        services: readJson(SERVICES_FILE, []),
        approvals: readJson(APPROVALS_FILE, []),
        dora: readJson(DORA_FILE, {}),
        configs: readJson(CONFIGS_FILE, {}),
        auditLogs: readJson(AUDIT_FILE, [])
      };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="orbit-release-portal-backup-${new Date().toISOString().split('T')[0]}.json"`
      });
      return res.end(JSON.stringify(backup, null, 2));
    }

    // POST /api/reset-demo - Clean reset to pristine state
    if (pathname === '/api/reset-demo' && req.method === 'POST') {
      // Clear files
      const files = [RELEASES_FILE, DEPLOYMENTS_FILE, ENVIRONMENTS_FILE, SERVICES_FILE, APPROVALS_FILE, DORA_FILE, CONFIGS_FILE, AUDIT_FILE];
      files.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      seedInitialData();
      return sendJson(res, 200, { success: true, message: 'Portal demo data restored to pristine state' });
    }

    // ----------------------------------------------------
    // 10. STATIC ASSETS FALLBACK
    // ----------------------------------------------------
    return serveStaticFile(req, res, pathname);

  } catch (err) {
    console.error('Unhandled server error:', err);
    return sendJson(res, 500, { error: 'Internal Server Error', message: err.message });
  }
});

// Start listening if executed directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` OrbitOps - Enterprise Release & Deployment Portal`);
    console.log(` Running on: http://localhost:${PORT}`);
    console.log(` Health Check: http://localhost:${PORT}/api/health`);
    console.log(`=======================================================`);
  });
}

module.exports = Object.assign(server, {
    calculateReleaseRisk,
    executeDeploymentWorkflow,
    triggerRollback
});
