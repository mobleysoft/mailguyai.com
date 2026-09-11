// AuthFor Standard Integration Library
// For use across all Mobley conglomerate sites (145 ventures)
// Provides unified authentication experience with automatic conglomerate-wide SSO

class AuthForStandard {
  constructor(options = {}) {
    this.clientId = options.clientId || 'af_mascom_standard';
    this.ventureName = options.ventureName || 'unknown_venture';
    this.redirectUrl = options.redirectUrl || window.location.origin + '/auth/callback';
    this.loginUISelector = options.loginUISelector || '#login-ui';
    this.errorSelector = options.errorSelector || '#login-error';

    // State
    this._user = null;
    this._token = localStorage.getItem('_authfor_token') || null;
    this._refreshToken = localStorage.getItem('_authfor_refresh') || null;
    this._sessionId = localStorage.getItem('_authfor_session') || null;
    this._mfaRequired = false;
    this._mfaPending = null;
    this._initialized = false;

    // Token refresh timer
    this._refreshTimer = null;
  }

  // Initialize authentication state on page load
  async init() {
    if (this._initialized) return;

    try {
      // Try to use existing token
      if (this._token) {
        this._user = await this._verifyToken();
        if (this._user) {
          this._setupAutoRefresh();
          this._initialized = true;
          this._onAuthSuccess();
          return { authenticated: true, user: this._user };
        }
      }

      // Try SSO redirect (if coming from another venture)
      const ssoToken = new URLSearchParams(window.location.search).get('sso_token');
      if (ssoToken) {
        await this._redeemSSO(ssoToken);
        return { authenticated: true, user: this._user };
      }

      // Show login UI
      this._showLoginUI();
      this._initialized = true;
      return { authenticated: false };
    } catch (e) {
      console.error('AuthFor init failed:', e);
      this._showLoginUI();
      this._initialized = true;
      return { authenticated: false, error: e.message };
    }
  }

  // Verify token is still valid
  async _verifyToken() {
    try {
      const res = await fetch('https://authfor.com/api/v1/verify', {
        headers: { 'Authorization': 'Bearer ' + this._token }
      });
      if (res.ok) {
        return await res.json();
      }
      throw new Error('Token invalid');
    } catch (e) {
      // Try refresh
      if (this._refreshToken) {
        return this._refreshSession();
      }
      throw e;
    }
  }

  // Handle registration
  async register(email, password, name) {
    const res = await fetch('https://authfor.com/api/v1/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password, name,
        client_id: this.clientId,
        venture_id: this.ventureName,
        redirect_url: this.redirectUrl
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Registration failed');
    }

    const data = await res.json();
    return this._processAuthResponse(data);
  }

  // Handle login
  async login(email, password) {
    const res = await fetch('https://authfor.com/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password,
        client_id: this.clientId,
        venture_id: this.ventureName,
        redirect_url: this.redirectUrl
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Login failed');
    }

    const data = await res.json();

    // Check if MFA required
    if (data.mfa_required) {
      this._mfaRequired = true;
      this._mfaPending = data.mfa_token;
      return { mfa_required: true, methods: data.mfa_methods };
    }

    return this._processAuthResponse(data);
  }

  // Verify MFA code
  async verifyMFA(code) {
    if (!this._mfaPending) throw new Error('No MFA pending');

    const res = await fetch('https://authfor.com/api/v1/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfa_token: this._mfaPending, code })
    });

    if (!res.ok) throw new Error('MFA verification failed');

    const data = await res.json();
    return this._processAuthResponse(data);
  }

  // Process successful auth response
  _processAuthResponse(data) {
    this._token = data.token;
    this._user = data.user;
    this._sessionId = data.session_id;
    this._mfaRequired = false;
    this._mfaPending = null;

    // Persist tokens
    localStorage.setItem('_authfor_token', this._token);
    localStorage.setItem('_authfor_session', this._sessionId);
    if (data.refresh_token) {
      this._refreshToken = data.refresh_token;
      localStorage.setItem('_authfor_refresh', this._refreshToken);
    }

    this._setupAutoRefresh();
    this._onAuthSuccess();

    return { success: true, user: this._user };
  }

  // Refresh session automatically
  async _refreshSession() {
    if (!this._refreshToken) throw new Error('No refresh token');

    const res = await fetch('https://authfor.com/api/v1/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: this._refreshToken,
        session_id: this._sessionId
      })
    });

    if (!res.ok) {
      this.logout();
      throw new Error('Session refresh failed');
    }

    const data = await res.json();
    this._token = data.token;
    localStorage.setItem('_authfor_token', this._token);
    return data.user || this._user;
  }

  // Setup automatic token refresh (refresh 1 min before expiry)
  _setupAutoRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);

    // Assume 24h token expiry
    const refreshIn = 23.99 * 60 * 60 * 1000; // 23h 59m

    this._refreshTimer = setTimeout(async () => {
      try {
        await this._refreshSession();
        this._setupAutoRefresh(); // Reschedule
      } catch (e) {
        console.warn('Token refresh failed:', e);
        this.logout();
      }
    }, refreshIn);
  }

  // Redeem SSO token from another venture
  async _redeemSSO(ssoToken) {
    const res = await fetch('https://authfor.com/api/v1/sso/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sso_token: ssoToken,
        client_id: this.clientId,
        venture_id: this.ventureName
      })
    });

    if (!res.ok) throw new Error('SSO redemption failed');

    const data = await res.json();
    return this._processAuthResponse(data);
  }

  // Generate SSO link for another venture
  getSSO_LinkFor(ventureName) {
    if (!this._token) return null;

    return `https://${ventureName}.com/auth/sso?sso_token=` +
           encodeURIComponent(this._token) +
           '&from=' + encodeURIComponent(this.ventureName);
  }

  // Show standard login UI
  _showLoginUI() {
    const container = document.querySelector(this.loginUISelector);
    if (!container) return;

    container.innerHTML = `
      <div style="max-width:400px;margin:100px auto;padding:20px;border:1px solid #333;border-radius:8px;background:#1a1a1a">
        <h2 style="margin:0 0 20px 0;color:#fff;font-size:20px">Sign In</h2>
        <div id="authfor-error" style="color:#ff4444;margin-bottom:10px;display:none"></div>

        <div style="margin-bottom:15px">
          <input type="email" id="authfor-email" placeholder="Email"
                 style="width:100%;padding:10px;border:1px solid #444;border-radius:4px;background:#0a0a0a;color:#fff;font-size:14px;box-sizing:border-box">
        </div>

        <div style="margin-bottom:15px">
          <input type="password" id="authfor-password" placeholder="Password"
                 style="width:100%;padding:10px;border:1px solid #444;border-radius:4px;background:#0a0a0a;color:#fff;font-size:14px;box-sizing:border-box">
        </div>

        <button id="authfor-login-btn" style="width:100%;padding:10px;background:#007fff;color:#fff;border:none;border-radius:4px;font-weight:600;cursor:pointer;font-size:14px">
          SIGN IN
        </button>

        <button id="authfor-register-btn" style="width:100%;padding:10px;margin-top:10px;background:transparent;color:#007fff;border:1px solid #007fff;border-radius:4px;font-weight:600;cursor:pointer;font-size:14px">
          CREATE ACCOUNT
        </button>
      </div>
      <div id="authfor-mfa" style="display:none;max-width:400px;margin:100px auto;padding:20px;border:1px solid #333;border-radius:8px;background:#1a1a1a">
        <h2 style="margin:0 0 20px 0;color:#fff;font-size:20px">Verify Code</h2>
        <input type="text" id="authfor-mfa-code" placeholder="Enter code from authenticator"
               style="width:100%;padding:10px;margin-bottom:15px;border:1px solid #444;border-radius:4px;background:#0a0a0a;color:#fff;font-size:14px;box-sizing:border-box">
        <button id="authfor-mfa-btn" style="width:100%;padding:10px;background:#007fff;color:#fff;border:none;border-radius:4px;font-weight:600;cursor:pointer;font-size:14px">
          VERIFY
        </button>
      </div>
    `;

    // Wire up UI handlers
    this._setupUIHandlers();
  }

  // Wire up login/register UI handlers
  _setupUIHandlers() {
    const emailInput = document.getElementById('authfor-email');
    const passInput = document.getElementById('authfor-password');
    const loginBtn = document.getElementById('authfor-login-btn');
    const registerBtn = document.getElementById('authfor-register-btn');
    const errorDiv = document.getElementById('authfor-error');

    loginBtn.onclick = async () => {
      const email = emailInput.value.trim();
      const password = passInput.value;

      if (!email || !password) {
        errorDiv.textContent = 'Email and password required';
        errorDiv.style.display = 'block';
        return;
      }

      loginBtn.disabled = true;
      loginBtn.textContent = 'SIGNING IN...';

      try {
        const result = await this.login(email, password);
        if (result.mfa_required) {
          document.querySelector(this.loginUISelector).style.display = 'none';
          document.getElementById('authfor-mfa').style.display = 'block';
          this._setupMFAHandler();
        }
      } catch (e) {
        errorDiv.textContent = e.message.toUpperCase();
        errorDiv.style.display = 'block';
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'SIGN IN';
      }
    };

    registerBtn.onclick = () => {
      const name = prompt('Name?');
      if (!name) return;

      registerBtn.disabled = true;
      registerBtn.textContent = 'CREATING ACCOUNT...';

      this.register(emailInput.value.trim(), passInput.value, name)
        .then(() => {
          errorDiv.style.display = 'none';
        })
        .catch(e => {
          errorDiv.textContent = e.message.toUpperCase();
          errorDiv.style.display = 'block';
        })
        .finally(() => {
          registerBtn.disabled = false;
          registerBtn.textContent = 'CREATE ACCOUNT';
        });
    };
  }

  // Wire up MFA handler
  _setupMFAHandler() {
    const mfaBtn = document.getElementById('authfor-mfa-btn');
    const mfaCode = document.getElementById('authfor-mfa-code');

    mfaBtn.onclick = async () => {
      mfaBtn.disabled = true;
      try {
        await this.verifyMFA(mfaCode.value);
      } catch (e) {
        alert(e.message);
      } finally {
        mfaBtn.disabled = false;
      }
    };
  }

  // Called on successful auth
  _onAuthSuccess() {
    // Hide login UI
    const loginUI = document.querySelector(this.loginUISelector);
    if (loginUI) loginUI.style.display = 'none';

    // Fire custom event
    window.dispatchEvent(new CustomEvent('authfor-success', { detail: this._user }));
  }

  // Logout
  async logout() {
    if (this._token) {
      try {
        await fetch('https://authfor.com/api/v1/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + this._token },
          body: JSON.stringify({ session_id: this._sessionId })
        });
      } catch (e) { /* cleanup locally anyway */ }
    }

    if (this._refreshTimer) clearTimeout(this._refreshTimer);

    this._token = null;
    this._user = null;
    this._refreshToken = null;
    this._sessionId = null;
    this._mfaRequired = false;
    this._mfaPending = null;

    localStorage.removeItem('_authfor_token');
    localStorage.removeItem('_authfor_refresh');
    localStorage.removeItem('_authfor_session');

    // Reload to show login UI
    window.location.reload();
  }

  // Public API
  isAuthenticated() { return !!this._token && !this._mfaRequired; }
  getUser() { return Promise.resolve(this._user); } // Return Promise for backward compatibility
  getToken() { return this._token; }

  // Alias for backward compatibility with old AuthFor SDK
  signIn(opts) { return this.login(opts.email, opts.password); }
}

// Export for use
window.AuthForStandard = AuthForStandard;
