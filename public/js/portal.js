/**
 * OrbitOps - Enterprise Release & Deployment Portal Frontend Engine
 * Real-time Telemetry, Dynamic Tab Routing, Pipeline Execution, & Governance
 */

// Application State
const state = {
  activeTab: 'overview',
  theme: localStorage.getItem('orbitops_theme') || 'dark',
  overview: null,
  releases: [],
  deployments: [],
  environments: [],
  envMatrix: [],
  services: [],
  approvals: [],
  dora: null,
  configs: null,
  auditLogs: [],
  selectedDeployment: null,
  sseConnection: null,
  charts: {},
  filterService: '',
  filterEnv: '',
  filterStatus: '',
  searchQuery: ''
};

// Toast Notifications
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const iconMap = {
    success: '✔',
    danger: '✖',
    warning: '⚠',
    info: 'ℹ'
  };

  toast.innerHTML = `
    <span style="font-weight: 700; font-size: 1rem;">${iconMap[type] || '•'}</span>
    <span style="flex: 1;">${message}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Formatters
function formatTime(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Tab Switching
function switchTab(tabId) {
  state.activeTab = tabId;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Update tab panels
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabId}`);
  });

  // Load specific data when tab opens
  if (tabId === 'overview') loadOverview();
  else if (tabId === 'environments') loadEnvironments();
  else if (tabId === 'deployments') loadDeployments();
  else if (tabId === 'releases') loadReleases();
  else if (tabId === 'approvals') loadApprovals();
  else if (tabId === 'configs') loadConfigs();
  else if (tabId === 'dora') loadDora();
  else if (tabId === 'audit') loadAuditLogs();
}

// -------------------------------------------------------------------------
// 1. OVERVIEW TAB
// -------------------------------------------------------------------------
async function loadOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    state.overview = data;

    // DORA headline cards
    const dora = data.doraSummary || {};
    document.getElementById('kpi-df').textContent = dora.deploymentFrequency ? dora.deploymentFrequency.value : '16.4';
    document.getElementById('kpi-lt').textContent = dora.leadTimeForChanges ? `${dora.leadTimeForChanges.value}h` : '3.2h';
    document.getElementById('kpi-cfr').textContent = dora.changeFailureRate ? `${dora.changeFailureRate.value}%` : '1.4%';
    document.getElementById('kpi-mttr').textContent = dora.meanTimeToRecovery ? `${dora.meanTimeToRecovery.value}m` : '12.8m';

    // Pending CAB badge in navbar
    const cabBadge = document.getElementById('badge-cab-count');
    if (cabBadge) {
      cabBadge.textContent = data.pendingApprovalsCount;
      cabBadge.style.display = data.pendingApprovalsCount > 0 ? 'inline-block' : 'none';
    }

    // Render Fleet Health Cards
    renderOverviewFleet(data.environments || []);

    // Render Active Deployment Ticker
    renderOverviewActiveDeployments(data.activeDeployments || []);

    // Render Recent Audit Feed
    renderOverviewAuditFeed(data.recentAuditLogs || []);

  } catch (err) {
    console.error('Failed to load overview:', err);
  }
}

function renderOverviewFleet(envs) {
  const container = document.getElementById('overview-fleet-grid');
  if (!container) return;

  container.innerHTML = envs.map(env => {
    const isFrozen = env.isFrozen;
    const statusBadgeClass = isFrozen ? 'badge-warning' : (env.status === 'healthy' ? 'badge-success' : 'badge-danger');
    const statusText = isFrozen ? 'FROZEN' : (env.status === 'healthy' ? 'HEALTHY' : 'DEGRADED');

    return `
      <div class="card env-card ${isFrozen ? 'env-frozen' : ''}">
        <div class="env-card-header">
          <div>
            <div class="env-name">${escapeHtml(env.name)}</div>
            <div class="env-region">${env.region} • ${env.cluster || 'k8s-cluster'}</div>
          </div>
          <span class="badge ${statusBadgeClass}">${statusText}</span>
        </div>

        <div class="env-metrics-grid">
          <div class="env-metric-item">
            <div class="val">${env.metrics?.cpuUsage || 45}%</div>
            <div class="lbl">CPU</div>
          </div>
          <div class="env-metric-item">
            <div class="val">${env.metrics?.memoryUsage || 60}%</div>
            <div class="lbl">Memory</div>
          </div>
          <div class="env-metric-item">
            <div class="val">${env.metrics?.errorRate || 0.01}%</div>
            <div class="lbl">5xx Error</div>
          </div>
          <div class="env-metric-item">
            <div class="val">${env.metrics?.p99LatencyMs || 80}ms</div>
            <div class="lbl">P99 Lat</div>
          </div>
        </div>

        ${isFrozen ? `
          <div style="font-size: 0.72rem; color: var(--accent-amber); margin-bottom: 0.5rem; background: var(--accent-amber-bg); padding: 0.35rem 0.5rem; border-radius: 4px;">
            ❄️ <strong>Lock:</strong> ${escapeHtml(env.freezeReason)}
          </div>
        ` : ''}

        <div class="env-card-actions">
          <span style="font-size: 0.75rem; color: var(--text-muted);">
            Active Deploys: <strong>${env.activeDeploymentsCount || 0}</strong>
          </span>
          <button class="btn btn-secondary" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="openFreezeModal('${env.id}')">
            ${isFrozen ? '🔓 Unfreeze' : '❄️ Freeze'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderOverviewActiveDeployments(activeDeps) {
  const container = document.getElementById('overview-active-dep-box');
  if (!container) return;

  if (!activeDeps || activeDeps.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
        <span style="font-size: 1.5rem; display: block; margin-bottom: 0.5rem;">🟢</span>
        All systems stable. No active deployment pipelines running.
        <div style="margin-top: 0.75rem;">
          <button class="btn btn-primary" onclick="openDeployModal()">Trigger New Deployment</button>
        </div>
      </div>
    `;
    return;
  }

  const dep = activeDeps[0]; // focus on primary active
  container.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
      <div>
        <div style="display: flex; align-items: center; gap: 0.6rem;">
          <span class="live-indicator"><span class="pulse-dot"></span> PIPELINE RUNNING</span>
          <h3 style="font-size: 1.1rem; font-weight: 700;">${escapeHtml(dep.serviceName)} (${escapeHtml(dep.version)})</h3>
        </div>
        <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 0.2rem;">
          Target: <strong>${escapeHtml(dep.environment.toUpperCase())}</strong> | Strategy: <strong>${dep.strategy.toUpperCase()}</strong> | Started: ${formatTime(dep.startedAt)} by ${escapeHtml(dep.deployedBy)}
        </div>
      </div>

      <div style="display: flex; gap: 0.5rem;">
        <button class="btn btn-secondary" onclick="viewDeploymentDetails('${dep.id}')">Open Console</button>
        <button class="btn btn-danger" onclick="openRollbackModal('${dep.id}')">🚨 Abort / Rollback</button>
      </div>
    </div>

    <!-- Stepper -->
    <div class="pipeline-stepper">
      ${(dep.stages || []).map((st, idx) => {
        let cls = 'pending';
        let icon = idx + 1;
        if (st.status === 'completed') {
          cls = 'completed';
          icon = '✔';
        } else if (st.status === 'in_progress') {
          cls = 'in-progress';
          icon = '⚡';
        }
        return `
          <div class="stage-step ${cls}">
            <div class="step-indicator">${icon}</div>
            <div class="step-title">${escapeHtml(st.name)}</div>
          </div>
        `;
      }).join('')}
    </div>

    <!-- Traffic Split Bar -->
    <div style="margin-top: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border-radius: 6px;">
      <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.35rem;">
        <span>Canary Traffic Weight: <strong>${dep.canaryTrafficPercent || 0}%</strong></span>
        <span>Baseline Stable Traffic: <strong>${100 - (dep.canaryTrafficPercent || 0)}%</strong></span>
      </div>
      <div class="traffic-gauge">
        <div class="traffic-fill" style="width: ${dep.canaryTrafficPercent || 0}%;"></div>
      </div>
    </div>
  `;
}

function renderOverviewAuditFeed(logs) {
  const container = document.getElementById('overview-audit-list');
  if (!container) return;

  container.innerHTML = logs.map(l => `
    <div style="display: flex; gap: 0.75rem; padding: 0.6rem 0; border-bottom: 1px solid var(--border-color); font-size: 0.8rem;">
      <span style="font-family: monospace; color: var(--text-muted); font-size: 0.72rem; white-space: nowrap;">${formatTime(l.timestamp)}</span>
      <span class="badge ${l.status === 'WARNING' ? 'badge-warning' : (l.status === 'FAILED' ? 'badge-danger' : 'badge-info')}" style="height: fit-content; font-size: 0.65rem;">
        ${l.action}
      </span>
      <div style="flex: 1;">
        <span style="font-weight: 600;">${escapeHtml(l.target)}</span>
        <span style="color: var(--text-secondary); margin-left: 0.4rem;">${escapeHtml(l.details)}</span>
      </div>
      <span style="color: var(--text-muted); font-size: 0.72rem;">${escapeHtml(l.actor)}</span>
    </div>
  `).join('');
}

// -------------------------------------------------------------------------
// 2. MULTI-ENVIRONMENT FLEET & VERSION DRIFT MATRIX
// -------------------------------------------------------------------------
async function loadEnvironments() {
  try {
    const res = await fetch('/api/environments');
    const data = await res.json();
    state.environments = data.environments || [];
    state.envMatrix = data.matrix || [];

    renderFleetCards(state.environments);
    renderMatrixTable(state.envMatrix, state.environments);
  } catch (err) {
    console.error('Failed to load environments:', err);
  }
}

function renderFleetCards(envs) {
  const container = document.getElementById('fleet-cards-grid');
  if (!container) return;
  renderOverviewFleet(envs); // Reuses responsive fleet card layout
}

function renderMatrixTable(matrix, envs) {
  const headRow = document.getElementById('matrix-table-head-row');
  const body = document.getElementById('matrix-table-body');
  if (!headRow || !body) return;

  // Render headers
  headRow.innerHTML = `
    <th>Microservice</th>
    <th>Tier</th>
    ${envs.map(e => `
      <th>
        ${escapeHtml(e.name)}
        ${e.isFrozen ? '<span title="Frozen" style="color: var(--accent-amber);"> ❄️</span>' : ''}
      </th>
    `).join('')}
    <th>Actions</th>
  `;

  // Render rows
  body.innerHTML = matrix.map(item => {
    // Check if there is drift between staging and prod-us
    const stagingVer = item.versions['staging'] || '';
    const prodVer = item.versions['prod-us'] || '';
    const hasDrift = stagingVer && prodVer && stagingVer !== prodVer;

    return `
      <tr>
        <td>
          <div style="font-weight: 600;">${escapeHtml(item.serviceName)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); font-family: monospace;">${item.serviceId}</div>
        </td>
        <td>
          <span class="badge ${item.tier && item.tier.includes('Tier-0') ? 'badge-danger' : 'badge-info'}">
            ${item.tier || 'Tier-1'}
          </span>
        </td>
        ${envs.map(env => {
          const ver = item.versions[env.id] || '--';
          const isDriftCell = hasDrift && (env.id === 'staging' || env.id === 'prod-us');
          return `
            <td>
              <span class="matrix-cell-version ${isDriftCell ? 'drift' : 'synced'}">
                ${escapeHtml(ver)}
              </span>
            </td>
          `;
        }).join('')}
        <td>
          <button class="btn btn-secondary" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="quickPromoteService('${item.serviceId}', '${item.serviceName}', '${stagingVer}')">
            🚀 Promote
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// -------------------------------------------------------------------------
// 3. DEPLOYMENTS PIPELINES & REAL-TIME CONSOLE
// -------------------------------------------------------------------------
async function loadDeployments() {
  try {
    let url = '/api/deployments';
    const params = new URLSearchParams();
    if (state.filterEnv) params.append('environment', state.filterEnv);
    if (state.filterService) params.append('serviceId', state.filterService);
    if (state.filterStatus) params.append('status', state.filterStatus);
    if (params.toString()) url += `?${params.toString()}`;

    const res = await fetch(url);
    const deployments = await res.json();
    state.deployments = deployments;

    renderDeploymentsTable(deployments);

    // If currently viewing a deployment, refresh its console
    if (state.selectedDeployment) {
      const refreshed = deployments.find(d => d.id === state.selectedDeployment.id);
      if (refreshed) {
        state.selectedDeployment = refreshed;
        renderConsoleView(refreshed);
      }
    } else if (deployments.length > 0) {
      viewDeploymentDetails(deployments[0].id);
    }
  } catch (err) {
    console.error('Failed to load deployments:', err);
  }
}

function renderDeploymentsTable(deployments) {
  const body = document.getElementById('deployments-table-body');
  if (!body) return;

  if (deployments.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">No deployments found.</td></tr>`;
    return;
  }

  body.innerHTML = deployments.map(d => {
    let statusBadge = 'badge-success';
    if (d.status === 'in_progress') statusBadge = 'badge-warning';
    else if (d.status === 'rolled_back' || d.status === 'failed') statusBadge = 'badge-danger';

    return `
      <tr style="cursor: pointer;" onclick="viewDeploymentDetails('${d.id}')">
        <td>
          <span style="font-family: monospace; font-weight: 600; color: var(--accent-blue);">${d.id}</span>
        </td>
        <td>
          <div style="font-weight: 600;">${escapeHtml(d.serviceName)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(d.previousVersion)} ➔ <strong>${escapeHtml(d.version)}</strong></div>
        </td>
        <td>
          <span class="badge badge-info">${escapeHtml(d.environment.toUpperCase())}</span>
        </td>
        <td>
          <span style="font-size: 0.78rem; text-transform: uppercase; font-weight: 600;">${d.strategy}</span>
        </td>
        <td>
          <span class="badge ${statusBadge}">
            ${d.status === 'in_progress' ? '⚡ IN PROGRESS' : d.status.toUpperCase()}
          </span>
        </td>
        <td style="font-size: 0.75rem; color: var(--text-secondary);">
          <div>${formatDate(d.startedAt)}</div>
          <div style="font-size: 0.68rem; color: var(--text-muted);">${d.duration || 'In progress'}</div>
        </td>
        <td>
          <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.72rem;" onclick="event.stopPropagation(); viewDeploymentDetails('${d.id}')">
            Console
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function viewDeploymentDetails(depId) {
  const dep = state.deployments.find(d => d.id === depId);
  if (!dep) return;
  state.selectedDeployment = dep;

  renderConsoleView(dep);

  // Scroll to console view smoothly
  const consoleElem = document.getElementById('deployment-console-view');
  if (consoleElem) consoleElem.scrollIntoView({ behavior: 'smooth' });

  // Connect SSE for live logs
  initSseLogs(dep.id);
}

function renderConsoleView(dep) {
  const title = document.getElementById('console-title');
  const meta = document.getElementById('console-meta');
  const stepper = document.getElementById('console-stepper');
  const terminalBody = document.getElementById('terminal-log-body');
  const canaryControls = document.getElementById('console-canary-controls');

  if (title) title.textContent = `${dep.serviceName} - ${dep.version}`;
  if (meta) {
    meta.innerHTML = `
      Pipeline ID: <strong>${dep.id}</strong> | Target: <strong>${dep.environment.toUpperCase()}</strong> | Strategy: <strong>${dep.strategy.toUpperCase()}</strong> | Operator: <strong>${escapeHtml(dep.deployedBy)}</strong>
    `;
  }

  // Stepper
  if (stepper) {
    stepper.innerHTML = (dep.stages || []).map((st, idx) => {
      let cls = 'pending';
      let icon = idx + 1;
      if (st.status === 'completed') {
        cls = 'completed';
        icon = '✔';
      } else if (st.status === 'in_progress') {
        cls = 'in-progress';
        icon = '⚡';
      }
      return `
        <div class="stage-step ${cls}">
          <div class="step-indicator">${icon}</div>
          <div class="step-title">${escapeHtml(st.name)}</div>
        </div>
      `;
    }).join('');
  }

  // Canary Controls
  if (canaryControls) {
    if (dep.status === 'in_progress') {
      canaryControls.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 0.8rem; font-weight: 600;">Shift Canary Traffic:</span>
            <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="setCanaryWeight('${dep.id}', 10)">10%</button>
            <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="setCanaryWeight('${dep.id}', 25)">25%</button>
            <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="setCanaryWeight('${dep.id}', 50)">50%</button>
            <button class="btn btn-success" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="setCanaryWeight('${dep.id}', 100)">Promote to 100%</button>
          </div>
          <button class="btn btn-danger" onclick="openRollbackModal('${dep.id}')">🚨 Trigger Instant Rollback</button>
        </div>
      `;
    } else {
      canaryControls.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.8rem; color: var(--text-secondary);">
            Pipeline Status: <strong style="color: ${dep.status === 'success' ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">${dep.status.toUpperCase()}</strong>
          </span>
          ${dep.status === 'success' ? `
            <button class="btn btn-danger" style="padding: 0.3rem 0.75rem; font-size: 0.75rem;" onclick="openRollbackModal('${dep.id}')">Emergency Revert / Rollback</button>
          ` : ''}
        </div>
      `;
    }
  }

  // Terminal Logs
  if (terminalBody) {
    terminalBody.innerHTML = (dep.logs || []).map(l => `
      <div class="log-line">
        <span class="log-time">[${formatTime(l.timestamp)}]</span>
        <span class="log-level ${l.level}">${l.level}</span>
        <span class="log-msg">${escapeHtml(l.message)}</span>
      </div>
    `).join('');
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }
}

function initSseLogs(depId) {
  if (state.sseConnection) {
    state.sseConnection.close();
    state.sseConnection = null;
  }

  const sse = new EventSource(`/api/deployments/${depId}/events`);
  state.sseConnection = sse;

  sse.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'log') {
        const terminalBody = document.getElementById('terminal-log-body');
        if (terminalBody && data.log) {
          const div = document.createElement('div');
          div.className = 'log-line';
          div.innerHTML = `
            <span class="log-time">[${formatTime(data.log.timestamp)}]</span>
            <span class="log-level ${data.log.level}">${data.log.level}</span>
            <span class="log-msg">${escapeHtml(data.log.message)}</span>
          `;
          terminalBody.appendChild(div);
          terminalBody.scrollTop = terminalBody.scrollHeight;
        }

        if (data.deployment) {
          state.selectedDeployment = data.deployment;
          renderConsoleView(data.deployment);
        }
      } else if (data.type === 'status_update') {
        loadDeployments();
        loadOverview();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };

  sse.onerror = () => {
    sse.close();
  };
}

async function setCanaryWeight(depId, percent) {
  try {
    const res = await fetch(`/api/deployments/${depId}/canary-traffic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent, actor: 'Elena Rostova (SRE Lead)' })
    });
    if (res.ok) {
      showToast(`Canary traffic split updated to ${percent}%`, 'success');
      loadDeployments();
    }
  } catch (err) {
    showToast('Failed to adjust canary weight', 'danger');
  }
}

// -------------------------------------------------------------------------
// 4. RELEASES & RELEASE TRAIN MANAGEMENT
// -------------------------------------------------------------------------
async function loadReleases() {
  try {
    const res = await fetch('/api/releases');
    const releases = await res.json();
    state.releases = releases;

    renderReleasesBoard(releases);
    renderReleasesTable(releases);
  } catch (err) {
    console.error('Failed to load releases:', err);
  }
}

function renderReleasesBoard(releases) {
  // Group releases by status
  const statuses = ['in_review', 'approved', 'released', 'rolled_back'];
  statuses.forEach(st => {
    const col = document.getElementById(`board-col-${st}`);
    if (!col) return;
    const items = releases.filter(r => r.status === st);
    col.innerHTML = items.map(r => `
      <div class="card" style="padding: 0.85rem; margin-bottom: 0.75rem; border-left: 3px solid ${getRiskColor(r.riskLevel)};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.35rem;">
          <span style="font-weight: 700; font-size: 0.85rem;">${escapeHtml(r.version)}</span>
          <span class="badge ${r.riskLevel === 'critical' ? 'badge-danger' : (r.riskLevel === 'high' ? 'badge-warning' : 'badge-info')}" style="font-size: 0.65rem;">
            ${r.riskLevel ? r.riskLevel.toUpperCase() : 'LOW'}
          </span>
        </div>
        <div style="font-size: 0.78rem; font-weight: 600; margin-bottom: 0.35rem;">${escapeHtml(r.title)}</div>
        <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(r.serviceName)}</div>
        <div style="margin-top: 0.6rem; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.68rem; color: var(--text-secondary);">${r.pullRequests ? r.pullRequests.length : 0} PRs</span>
          <button class="btn btn-secondary" style="padding: 0.2rem 0.45rem; font-size: 0.7rem;" onclick="openReleaseNotesModal('${r.id}')">Notes</button>
        </div>
      </div>
    `).join('');
  });
}

function renderReleasesTable(releases) {
  const body = document.getElementById('releases-table-body');
  if (!body) return;

  body.innerHTML = releases.map(r => `
    <tr>
      <td>
        <span style="font-weight: 700; color: var(--accent-blue);">${escapeHtml(r.version)}</span>
        <div style="font-size: 0.72rem; color: var(--text-muted);">${r.releaseType || 'minor'}</div>
      </td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(r.title)}</div>
        <div style="font-size: 0.72rem; color: var(--text-secondary);">${escapeHtml(r.serviceName)}</div>
      </td>
      <td>
        <span class="badge ${r.riskLevel === 'critical' ? 'badge-danger' : (r.riskLevel === 'high' ? 'badge-warning' : 'badge-info')}">
          ${r.riskLevel ? r.riskLevel.toUpperCase() : 'LOW'} (${r.riskScore || 20})
        </span>
      </td>
      <td>
        <span class="badge badge-info">${escapeHtml(r.targetEnvironment.toUpperCase())}</span>
      </td>
      <td>
        <span class="badge ${r.status === 'released' ? 'badge-success' : (r.status === 'approved' ? 'badge-info' : 'badge-warning')}">
          ${r.status.toUpperCase()}
        </span>
      </td>
      <td style="font-size: 0.75rem;">
        <div>${escapeHtml(r.author)}</div>
        <div style="color: var(--text-muted); font-size: 0.68rem;">${formatDate(r.createdAt)}</div>
      </td>
      <td>
        <div style="display: flex; gap: 0.4rem;">
          <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.72rem;" onclick="openReleaseNotesModal('${r.id}')">
            Changelog
          </button>
          ${r.status === 'approved' ? `
            <button class="btn btn-primary" style="padding: 0.25rem 0.5rem; font-size: 0.72rem;" onclick="triggerReleaseDeploy('${r.id}')">
              Deploy
            </button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function getRiskColor(level) {
  if (level === 'critical') return 'var(--accent-rose)';
  if (level === 'high') return 'var(--accent-amber)';
  return 'var(--accent-blue)';
}

// -------------------------------------------------------------------------
// 5. CHANGE ADVISORY BOARD (CAB) APPROVALS
// -------------------------------------------------------------------------
async function loadApprovals() {
  try {
    const res = await fetch('/api/approvals');
    const approvals = await res.json();
    state.approvals = approvals;

    renderApprovalsTable(approvals);
  } catch (err) {
    console.error('Failed to load approvals:', err);
  }
}

function renderApprovalsTable(approvals) {
  const body = document.getElementById('approvals-table-body');
  if (!body) return;

  if (approvals.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">No pending CAB requests.</td></tr>`;
    return;
  }

  body.innerHTML = approvals.map(a => `
    <tr>
      <td><span style="font-family: monospace; font-weight: 600;">${a.id}</span></td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(a.title)}</div>
        <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(a.service)} ➔ ${escapeHtml(a.targetEnv.toUpperCase())}</div>
      </td>
      <td>
        <span class="badge ${a.riskLevel === 'CRITICAL' ? 'badge-danger' : (a.riskLevel === 'HIGH' ? 'badge-warning' : 'badge-info')}">
          ${a.riskLevel} (${a.riskScore}/100)
        </span>
        <div style="font-size: 0.68rem; color: var(--text-muted); margin-top: 0.2rem;">
          ${(a.riskFactors || []).slice(0, 1).join('')}
        </div>
      </td>
      <td>
        <span style="font-size: 0.75rem;">${a.currentApprovals ? a.currentApprovals.length : 0} of ${a.approvalsRequired} Signatures</span>
        <div style="font-size: 0.68rem; color: var(--text-secondary);">
          Pending: ${a.pendingRoles && a.pendingRoles.length ? a.pendingRoles.join(', ') : 'None'}
        </div>
      </td>
      <td>
        <span class="badge ${a.status === 'APPROVED' ? 'badge-success' : (a.status === 'REJECTED' ? 'badge-danger' : 'badge-warning')}">
          ${a.status}
        </span>
      </td>
      <td style="font-size: 0.75rem;">
        <div>${escapeHtml(a.requestedBy)}</div>
        <div style="color: var(--text-muted); font-size: 0.68rem;">${formatDate(a.createdAt)}</div>
      </td>
      <td>
        ${a.status === 'PENDING' ? `
          <div style="display: flex; gap: 0.4rem;">
            <button class="btn btn-success" style="padding: 0.25rem 0.5rem; font-size: 0.72rem;" onclick="approveCab('${a.id}')">
              ✔ Sign Off
            </button>
            <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.72rem;" onclick="rejectCab('${a.id}')">
              ✖ Reject
            </button>
          </div>
        ` : `
          <span style="font-size: 0.72rem; color: var(--text-muted);">Completed</span>
        `}
      </td>
    </tr>
  `).join('');
}

async function approveCab(approvalId) {
  try {
    const res = await fetch(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'Release Engineering Lead',
        approver: 'Marcus Vance',
        comment: 'Pre-flight checks passed, lock-free migration verified.'
      })
    });
    if (res.ok) {
      showToast('Change Advisory Board sign-off recorded', 'success');
      loadApprovals();
      loadOverview();
    }
  } catch (err) {
    showToast('Failed to record approval', 'danger');
  }
}

async function rejectCab(approvalId) {
  const reason = prompt('Please specify the compliance rejection reason:') || 'Risk thresholds exceeded';
  try {
    const res = await fetch(`/api/approvals/${approvalId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approver: 'CAB Committee',
        reason
      })
    });
    if (res.ok) {
      showToast('Release deployment rejected', 'warning');
      loadApprovals();
    }
  } catch (err) {
    showToast('Failed to reject approval', 'danger');
  }
}

// -------------------------------------------------------------------------
// 6. CONFIG & SECRET DRIFT AUDITOR
// -------------------------------------------------------------------------
async function loadConfigs() {
  try {
    const service = document.getElementById('config-service-select')?.value || 'svc-payments';
    const envA = document.getElementById('config-envA-select')?.value || 'staging';
    const envB = document.getElementById('config-envB-select')?.value || 'prod-us';

    const res = await fetch(`/api/configs/diff?serviceId=${service}&envA=${envA}&envB=${envB}`);
    const data = await res.json();
    state.configs = data;

    renderConfigDiffTable(data);
  } catch (err) {
    console.error('Failed to load configs:', err);
  }
}

function renderConfigDiffTable(data) {
  const body = document.getElementById('config-diff-table-body');
  const summary = document.getElementById('config-diff-summary');
  if (!body) return;

  if (summary) {
    summary.innerHTML = `
      Comparing <strong>${escapeHtml(data.serviceId)}</strong> across <strong>${data.envA.toUpperCase()}</strong> vs <strong>${data.envB.toUpperCase()}</strong>. Total: ${data.totalVariables} vars | Drifts Detected: <strong style="color: ${data.driftsCount > 0 ? 'var(--accent-amber)' : 'var(--accent-emerald)'};">${data.driftsCount}</strong>
    `;
  }

  body.innerHTML = (data.comparison || []).map(v => {
    let statusBadge = 'badge-success';
    if (v.status === 'DRIFT_DETECTED') statusBadge = 'badge-warning';
    else if (v.status === 'SECURE_MATCH') statusBadge = 'badge-purple';

    return `
      <tr>
        <td style="font-family: monospace; font-weight: 600;">
          ${escapeHtml(v.key)}
          ${v.isSecret ? '<span title="Secret" style="color: var(--accent-purple);"> 🔒</span>' : ''}
        </td>
        <td style="font-family: monospace; font-size: 0.78rem;">${escapeHtml(v.envA.value)}</td>
        <td style="font-family: monospace; font-size: 0.78rem;">${escapeHtml(v.envB.value)}</td>
        <td>
          <span class="badge ${statusBadge}">${v.status.replace('_', ' ')}</span>
        </td>
      </tr>
    `;
  }).join('');
}

// -------------------------------------------------------------------------
// 7. DORA METRICS & CHARTS
// -------------------------------------------------------------------------
async function loadDora() {
  try {
    const res = await fetch('/api/dora');
    const data = await res.json();
    state.dora = data;

    renderDoraCharts(data);
  } catch (err) {
    console.error('Failed to load DORA metrics:', err);
  }
}

function renderDoraCharts(dora) {
  if (typeof Chart === 'undefined') return;

  // Chart 1: Deployment Frequency Trend
  const ctxDf = document.getElementById('chart-df-trend');
  if (ctxDf) {
    if (state.charts.df) state.charts.df.destroy();
    state.charts.df = new Chart(ctxDf, {
      type: 'line',
      data: {
        labels: dora.weeklyTrends.map(w => w.week),
        datasets: [{
          label: 'Weekly Deployments',
          data: dora.weeklyTrends.map(w => w.deploys),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          tension: 0.35,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#1f2937' }, ticks: { color: '#9ca3af' } },
          x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
        }
      }
    });
  }

  // Chart 2: Failure Rate & MTTR
  const ctxCfr = document.getElementById('chart-cfr-trend');
  if (ctxCfr) {
    if (state.charts.cfr) state.charts.cfr.destroy();
    state.charts.cfr = new Chart(ctxCfr, {
      type: 'bar',
      data: {
        labels: dora.weeklyTrends.map(w => w.week),
        datasets: [{
          label: 'Change Failure Rate (%)',
          data: dora.weeklyTrends.map(w => w.failureRatePct),
          backgroundColor: '#f59e0b',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#1f2937' }, ticks: { color: '#9ca3af' } },
          x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
        }
      }
    });
  }

  // Chart 3: Failure Root Causes
  const ctxFailures = document.getElementById('chart-failure-causes');
  if (ctxFailures && dora.failureCauses) {
    if (state.charts.failures) state.charts.failures.destroy();
    state.charts.failures = new Chart(ctxFailures, {
      type: 'doughnut',
      data: {
        labels: dora.failureCauses.map(f => f.cause),
        datasets: [{
          data: dora.failureCauses.map(f => f.percentage),
          backgroundColor: ['#3b82f6', '#f59e0b', '#f43f5e', '#8b5cf6']
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 10 } } }
        }
      }
    });
  }
}

// -------------------------------------------------------------------------
// 8. AUDIT LOGS
// -------------------------------------------------------------------------
async function loadAuditLogs() {
  try {
    let url = '/api/audit-logs';
    if (state.searchQuery) url += `?q=${encodeURIComponent(state.searchQuery)}`;
    const res = await fetch(url);
    const logs = await res.json();
    state.auditLogs = logs;

    const body = document.getElementById('audit-table-body');
    if (!body) return;

    body.innerHTML = logs.map(l => `
      <tr>
        <td style="font-family: monospace; font-size: 0.75rem; color: var(--text-muted);">${formatDate(l.timestamp)}</td>
        <td><span class="badge ${l.status === 'WARNING' ? 'badge-warning' : (l.status === 'FAILED' ? 'badge-danger' : 'badge-info')}">${l.action}</span></td>
        <td style="font-weight: 600;">${escapeHtml(l.target)}</td>
        <td><span class="badge badge-info">${escapeHtml(l.environment)}</span></td>
        <td style="font-size: 0.78rem;">${escapeHtml(l.details)}</td>
        <td style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(l.actor)}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load audit logs:', err);
  }
}

// -------------------------------------------------------------------------
// MODALS & ACTIONS
// -------------------------------------------------------------------------
function openDeployModal() {
  const modal = document.getElementById('modal-deploy');
  if (!modal) return;

  // Populate services dropdown
  const svcSelect = document.getElementById('deploy-service-select');
  if (svcSelect) {
    fetch('/api/services')
      .then(r => r.json())
      .then(services => {
        state.services = services;
        svcSelect.innerHTML = services.map(s => `
          <option value="${s.id}">${escapeHtml(s.name)} (${s.tier})</option>
        `).join('');
      });
  }

  modal.classList.add('active');
}

async function submitDeploy() {
  const serviceId = document.getElementById('deploy-service-select').value;
  const version = document.getElementById('deploy-version-input').value.trim();
  const environment = document.getElementById('deploy-env-select').value;
  const strategy = document.getElementById('deploy-strategy-select').value;
  const bypassFreeze = document.getElementById('deploy-bypass-freeze')?.checked || false;

  if (!version) {
    alert('Please enter a release version (e.g. v3.4.0)');
    return;
  }

  try {
    const res = await fetch('/api/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId,
        version,
        environment,
        strategy,
        bypassFreeze,
        deployedBy: 'Elena Rostova (Lead SRE)'
      })
    });

    const data = await res.json();
    if (res.status === 201) {
      showToast(`Deployment ${data.id} initiated successfully!`, 'success');
      closeModals();
      switchTab('deployments');
      loadDeployments();
      loadOverview();
      viewDeploymentDetails(data.id);
    } else {
      showToast(data.error || 'Failed to trigger deployment', 'danger', 5000);
    }
  } catch (err) {
    showToast('Network error during deployment trigger', 'danger');
  }
}

function openCreateReleaseModal() {
  const modal = document.getElementById('modal-create-release');
  if (!modal) return;

  const svcSelect = document.getElementById('release-service-select');
  if (svcSelect) {
    fetch('/api/services')
      .then(r => r.json())
      .then(services => {
        svcSelect.innerHTML = services.map(s => `
          <option value="${s.id}">${escapeHtml(s.name)}</option>
        `).join('');
      });
  }

  modal.classList.add('active');
}

async function submitCreateRelease() {
  const serviceId = document.getElementById('release-service-select').value;
  const version = document.getElementById('release-version-input').value.trim();
  const title = document.getElementById('release-title-input').value.trim();
  const releaseType = document.getElementById('release-type-select').value;
  const targetEnvironment = document.getElementById('release-target-env-select').value;
  const highlights = document.getElementById('release-highlights-input').value.trim();
  const dbMigration = document.getElementById('release-db-migration-input').value.trim();

  if (!version || !title) {
    alert('Version and Title are required');
    return;
  }

  const payload = {
    serviceId,
    version,
    title,
    releaseType,
    targetEnvironment,
    highlights,
    author: 'Marcus Vance',
    databaseMigrations: dbMigration ? [dbMigration] : []
  };

  try {
    const res = await fetch('/api/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status === 201) {
      showToast(`Release plan ${version} created!`, 'success');
      closeModals();
      switchTab('releases');
      loadReleases();
      loadOverview();
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed to create release', 'danger');
    }
  } catch (e) {
    showToast('Failed to submit release', 'danger');
  }
}

function openRollbackModal(depId) {
  const modal = document.getElementById('modal-rollback');
  if (!modal) return;
  document.getElementById('rollback-dep-id').value = depId || '';
  modal.classList.add('active');
}

async function submitRollback() {
  const depId = document.getElementById('rollback-dep-id').value;
  const reason = document.getElementById('rollback-reason-input').value.trim() || 'Circuit breaker regression trigger';

  try {
    const res = await fetch(`/api/deployments/${depId}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'On-Call SRE', reason })
    });

    const data = await res.json();
    if (res.ok) {
      showToast('Emergency rollback successfully executed!', 'warning', 4500);
      closeModals();
      loadDeployments();
      loadOverview();
      if (data.rollbackDeployment) {
        viewDeploymentDetails(data.rollbackDeployment.id);
      }
    } else {
      showToast(data.error || 'Failed to execute rollback', 'danger');
    }
  } catch (err) {
    showToast('Rollback failed', 'danger');
  }
}

function openFreezeModal(envId) {
  const modal = document.getElementById('modal-freeze');
  if (!modal) return;

  const env = (state.environments || []).find(e => e.id === envId);
  document.getElementById('freeze-env-id').value = envId;
  const isCurrentlyFrozen = env ? env.isFrozen : false;

  document.getElementById('freeze-modal-title').textContent = isCurrentlyFrozen ? `Unlock ${env?.name || envId}` : `Freeze ${env?.name || envId}`;
  document.getElementById('freeze-submit-btn').textContent = isCurrentlyFrozen ? 'Unlock Environment' : 'Lock Environment';
  document.getElementById('freeze-reason-group').style.display = isCurrentlyFrozen ? 'none' : 'block';

  modal.classList.add('active');
}

async function submitFreeze() {
  const envId = document.getElementById('freeze-env-id').value;
  const env = (state.environments || []).find(e => e.id === envId);
  const willFreeze = !env?.isFrozen;
  const reason = document.getElementById('freeze-reason-input').value.trim() || 'Scheduled Change Freeze Window';

  try {
    const res = await fetch(`/api/environments/${envId}/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isFrozen: willFreeze,
        reason,
        actor: 'Release Commander'
      })
    });

    if (res.ok) {
      showToast(`Environment ${envId.toUpperCase()} ${willFreeze ? 'FROZEN' : 'UNFROZEN'}!`, willFreeze ? 'warning' : 'success');
      closeModals();
      loadEnvironments();
      loadOverview();
    }
  } catch (e) {
    showToast('Failed to toggle freeze', 'danger');
  }
}

async function openReleaseNotesModal(releaseId) {
  const modal = document.getElementById('modal-notes');
  if (!modal) return;

  try {
    const res = await fetch(`/api/releases/${releaseId}/generate-notes`, { method: 'POST' });
    const data = await res.json();

    document.getElementById('notes-markdown-raw').value = data.markdown;

    // Simple markdown-to-HTML formatter
    const htmlContent = data.markdown
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^\- (.*$)/gim, '<li>$1</li>')
      .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
      .replace(/\`(.*?)\`/gim, '<code>$1</code>')
      .replace(/\n\n/gim, '<p></p>');

    document.getElementById('notes-rendered-view').innerHTML = htmlContent;
    modal.classList.add('active');
  } catch (err) {
    showToast('Failed to generate release notes', 'danger');
  }
}

function copyNotesToClipboard() {
  const raw = document.getElementById('notes-markdown-raw').value;
  navigator.clipboard.writeText(raw);
  showToast('Release notes copied to clipboard!', 'success');
}

function quickPromoteService(serviceId, serviceName, version) {
  openDeployModal();
  setTimeout(() => {
    const svcSelect = document.getElementById('deploy-service-select');
    if (svcSelect) svcSelect.value = serviceId;
    const verInput = document.getElementById('deploy-version-input');
    if (verInput) verInput.value = version || 'v1.0.0';
    const envSelect = document.getElementById('deploy-env-select');
    if (envSelect) envSelect.value = 'prod-us';
  }, 200);
}

function triggerReleaseDeploy(releaseId) {
  const rel = state.releases.find(r => r.id === releaseId);
  if (!rel) return;
  openDeployModal();
  setTimeout(() => {
    document.getElementById('deploy-service-select').value = rel.serviceId;
    document.getElementById('deploy-version-input').value = rel.version;
    document.getElementById('deploy-env-select').value = rel.targetEnvironment;
  }, 200);
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('orbitops_theme', state.theme);
}

async function resetDemoData() {
  if (!confirm('Reset all demo data back to pristine state?')) return;
  try {
    const res = await fetch('/api/reset-demo', { method: 'POST' });
    if (res.ok) {
      showToast('Demo data restored cleanly', 'success');
      loadOverview();
      loadEnvironments();
      loadDeployments();
      loadReleases();
    }
  } catch (e) {
    showToast('Reset failed', 'danger');
  }
}

// Global Init & Poller
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-theme', state.theme);

  // Bind Tab clicks
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Global search input
  const searchInput = document.getElementById('global-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      if (state.activeTab === 'audit') loadAuditLogs();
    });
  }

  // Initial load
  loadOverview();

  // Background poller every 3s to keep live telemetry and progress in sync
  setInterval(() => {
    if (state.activeTab === 'overview') loadOverview();
    else if (state.activeTab === 'deployments') loadDeployments();
  }, 3000);
});
