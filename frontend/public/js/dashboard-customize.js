// ============================================
// Customizable Dashboard Layout
// Drag & Drop, Show/Hide, Save Preferences
// ============================================

let dashboardLayout = {
  widgets: [],
  initialized: false
};

// Widget IDs yang tersedia
const AVAILABLE_WIDGETS = [
  { id: 'summary-cards', name: 'Summary Cards', default: true },
  { id: 'traffic-interface', name: 'Traffic Interface', default: true },
  { id: 'activity-chart', name: 'Activity Chart', default: true },
  { id: 'top-customers', name: 'Top Customers', default: true },
  { id: 'network-uptime', name: 'Network Uptime', default: true },
  { id: 'ticket-stats', name: 'Ticket Statistics', default: true },
  { id: 'bandwidth-trends', name: 'Bandwidth Trends', default: true },
  { id: 'customer-growth', name: 'Customer Growth', default: true },
  { id: 'revenue-forecast', name: 'Revenue Forecast', default: true },
  { id: 'device-status', name: 'Device Status', default: true },
  { id: 'billing-overview', name: 'Billing Overview', default: true }
];

// Initialize customizable dashboard
function initCustomizableDashboard() {
  if (dashboardLayout.initialized) return;
  
  // Add widget IDs to elements
  addWidgetIds();
  
  // Load saved layout
  loadDashboardLayout();
  
  // Add customize button to page header
  addCustomizeButton();
  
  // Apply saved layout
  applyDashboardLayout();
  
  dashboardLayout.initialized = true;
}

// Add IDs to widget elements
function addWidgetIds() {
  const summaryCards = document.querySelector('.summary-cards')?.parentElement;
  if (summaryCards) summaryCards.setAttribute('data-widget-id', 'summary-cards');
  
  const cards = document.querySelectorAll('.card');
  const cardTitles = {
    'Traffic Interface': 'traffic-interface',
    'Activity Chart': 'activity-chart',
    'Top Customers by Bandwidth': 'top-customers',
    'Network Uptime': 'network-uptime',
    'Ticket Statistics': 'ticket-stats',
    'Bandwidth Trends': 'bandwidth-trends',
    'Customer Growth': 'customer-growth',
    'Revenue Forecast': 'revenue-forecast',
    'Device Status': 'device-status',
    'Billing Overview': 'billing-overview'
  };
  
  cards.forEach(card => {
    const title = card.querySelector('h3')?.textContent;
    const widgetId = cardTitles[title];
    if (widgetId) {
      card.setAttribute('data-widget-id', widgetId);
    }
  });
}

// Load layout from localStorage
function loadDashboardLayout() {
  try {
    const saved = localStorage.getItem('dashboard_layout');
    if (saved) {
      dashboardLayout = JSON.parse(saved);
    } else {
      // Default layout
      dashboardLayout = {
        widgets: AVAILABLE_WIDGETS.map(w => ({ 
          id: w.id, 
          visible: w.default,
          order: AVAILABLE_WIDGETS.indexOf(w)
        })),
        initialized: false
      };
    }
  } catch (err) {
    console.error('Error loading dashboard layout:', err);
  }
}

// Save layout to localStorage
function saveDashboardLayout() {
  try {
    localStorage.setItem('dashboard_layout', JSON.stringify(dashboardLayout));
    showNotification('Layout saved successfully!', 'success');
  } catch (err) {
    console.error('Error saving dashboard layout:', err);
    showNotification('Failed to save layout', 'error');
  }
}

// Apply layout to dashboard
function applyDashboardLayout() {
  dashboardLayout.widgets.forEach(widget => {
    const element = document.querySelector(`[data-widget-id="${widget.id}"]`);
    if (element) {
      if (widget.visible) {
        element.style.display = '';
        element.classList.remove('widget-hidden');
      } else {
        element.style.display = 'none';
        element.classList.add('widget-hidden');
      }
    }
  });
}

// Add customize button
function addCustomizeButton() {
  const headerRight = document.querySelector('.page-header-right');
  if (!headerRight || document.getElementById('customizeDashboardBtn')) return;
  
  const btn = document.createElement('button');
  btn.id = 'customizeDashboardBtn';
  btn.className = 'btn-secondary';
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M12 1v6m0 6v6"></path>
      <path d="M21 12h-6m-6 0H3"></path>
    </svg>
    Customize
  `;
  btn.style.marginLeft = '8px';
  btn.addEventListener('click', openCustomizeModal);
  headerRight.appendChild(btn);
}

// Open customize modal
function openCustomizeModal() {
  const modal = createCustomizeModal();
  document.body.appendChild(modal);
  
  setTimeout(() => {
    modal.classList.add('show');
  }, 10);
}

// Create customize modal
function createCustomizeModal() {
  const modal = document.createElement('div');
  modal.className = 'customize-modal';
  modal.innerHTML = `
    <div class="customize-modal-overlay" onclick="closeCustomizeModal()"></div>
    <div class="customize-modal-content">
      <div class="customize-modal-header">
        <h3>Customize Dashboard</h3>
        <button class="modal-close" onclick="closeCustomizeModal()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="customize-modal-body">
        <div class="customize-section">
          <h4>Show/Hide Widgets</h4>
          <p class="section-desc">Toggle widgets visibility on your dashboard</p>
          <div class="widget-list" id="widgetToggleList">
            ${renderWidgetToggles()}
          </div>
        </div>
      </div>
      <div class="customize-modal-footer">
        <button class="btn-secondary" onclick="resetDashboardLayout()">Reset to Default</button>
        <div class="footer-actions">
          <button class="btn-secondary" onclick="closeCustomizeModal()">Cancel</button>
          <button class="btn-primary" onclick="saveAndApplyLayout()">Save Changes</button>
        </div>
      </div>
    </div>
  `;
  return modal;
}

// Render widget toggles
function renderWidgetToggles() {
  return dashboardLayout.widgets.map(widget => {
    const widgetInfo = AVAILABLE_WIDGETS.find(w => w.id === widget.id);
    return `
      <div class="widget-toggle-item">
        <label class="toggle-switch">
          <input 
            type="checkbox" 
            data-widget-id="${widget.id}"
            ${widget.visible ? 'checked' : ''}
            onchange="toggleWidget('${widget.id}', this.checked)"
          >
          <span class="toggle-slider"></span>
        </label>
        <div class="widget-info">
          <span class="widget-name">${widgetInfo?.name || widget.id}</span>
          <span class="widget-status ${widget.visible ? 'visible' : 'hidden'}">
            ${widget.visible ? 'Visible' : 'Hidden'}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

// Toggle widget visibility
function toggleWidget(widgetId, visible) {
  const widget = dashboardLayout.widgets.find(w => w.id === widgetId);
  if (widget) {
    widget.visible = visible;
    
    // Update status text
    const item = document.querySelector(`[data-widget-id="${widgetId}"]`)?.closest('.widget-toggle-item');
    const statusEl = item?.querySelector('.widget-status');
    if (statusEl) {
      statusEl.textContent = visible ? 'Visible' : 'Hidden';
      statusEl.className = `widget-status ${visible ? 'visible' : 'hidden'}`;
    }
  }
}

// Save and apply layout
function saveAndApplyLayout() {
  saveDashboardLayout();
  applyDashboardLayout();
  closeCustomizeModal();
  
  // Reload page to ensure all widgets refresh properly
  setTimeout(() => window.location.reload(), 500);
}

// Reset to default layout
function resetDashboardLayout() {
  if (!confirm('Reset dashboard to default layout? All widgets will be shown.')) return;
  
  dashboardLayout = {
    widgets: AVAILABLE_WIDGETS.map(w => ({ 
      id: w.id, 
      visible: w.default,
      order: AVAILABLE_WIDGETS.indexOf(w)
    })),
    initialized: true
  };
  
  saveDashboardLayout();
  closeCustomizeModal();
  
  setTimeout(() => window.location.reload(), 500);
}

// Close customize modal
function closeCustomizeModal() {
  const modal = document.querySelector('.customize-modal');
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 300);
  }
}

// Show notification
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.innerHTML = `
    <div class="notification-content">
      ${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}
      <span>${message}</span>
    </div>
  `;
  document.body.appendChild(notification);
  
  setTimeout(() => notification.classList.add('show'), 10);
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initCustomizableDashboard, 1000);
});
