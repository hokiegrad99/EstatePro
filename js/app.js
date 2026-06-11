/* ============================================
   EstatePro - Estate Management Application
   Shared JavaScript Module
   ============================================ */

const App = {
  /* ============================
     AUTHENTICATION
     ============================ */
  Auth: {
    async hashPassword(password) {
      const encoder = new TextEncoder();
      const data = encoder.encode(password);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    async init() {
      if (App.Crypto.isEncryptionEnabled() && !App.Crypto.hasPassphrase()) {
        return;
      }
      const users = await App.Crypto.readStorage('estatepro_users');
      if (!users || users.length === 0) {
        const hashedAdmin = await this.hashPassword('admin');
        const hashedExec = await this.hashPassword('executor');
        const hashedHeir = await this.hashPassword('heir');
        const hashedBen = await this.hashPassword('beneficiary');
        const defaultUsers = [
          { id: 1, username: 'admin', password: hashedAdmin, name: 'System Admin', role: 'Admin', email: 'admin@estatepro.local' },
          { id: 2, username: 'executor', password: hashedExec, name: 'Michael Johnson', role: 'Executor', email: 'michael@email.com' },
          { id: 3, username: 'heir', password: hashedHeir, name: 'Sarah Johnson', role: 'Heir', email: 'sarah@email.com' },
          { id: 4, username: 'beneficiary', password: hashedBen, name: 'David Johnson', role: 'Beneficiary', email: 'david@email.com' }
        ];
        this._usersCache = defaultUsers;
        await App.Crypto.writeStorage('estatepro_users', defaultUsers);
      } else {
        this._usersCache = users;
      }
    },

    getUsers() {
      if (this._usersCache) return this._usersCache;
      try {
        const raw = localStorage.getItem('estatepro_users');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ct && parsed.algo) {
          return [];
        }
        return parsed || [];
      } catch (e) { return []; }
    },

    saveUsers(users) {
      this._usersCache = users;
      return App.Crypto.writeStorage('estatepro_users', users).catch(err => console.error('Failed to save users:', err));
    },

    async register(username, password, name, role, email) {
      const users = this.getUsers();
      if (users.find(u => u.username === username)) {
        return { success: false, message: 'Username already exists.' };
      }
      const hashedPassword = await this.hashPassword(password);
      const newUser = {
        id: Date.now(),
        username,
        password: hashedPassword,
        name,
        role,
        email
      };
      users.push(newUser);
      this.saveUsers(users);
      return { success: true, message: 'Account created successfully.' };
    },

    async login(username, password) {
      const users = this.getUsers();
      const hashedPassword = await this.hashPassword(password);
      const user = users.find(u => u.username === username && u.password === hashedPassword);
      if (!user) {
        return { success: false, message: 'Invalid username or password.' };
      }
      const session = { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email };
      localStorage.setItem('estatepro_session', JSON.stringify(session));
      App.Crypto.savePassphraseToSession();
      return { success: true, message: 'Login successful.' };
    },

    logout() {
      App.Crypto.clearPassphraseFromSession();
      App.Crypto.clearKeyCache();
      localStorage.removeItem('estatepro_session');
      window.location.href = 'index.html';
    },

    getCurrentUser() {
      try { return JSON.parse(localStorage.getItem('estatepro_session')); }
      catch (e) { return null; }
    },

    checkSession() {
      const user = this.getCurrentUser();
      if (!user) {
        window.location.href = 'index.html';
        return null;
      }
      return user;
    },

    isLoggedIn() {
      return !!this.getCurrentUser();
    },

    async updateUserRole(userId, newRole) {
      const users = this.getUsers();
      const user = users.find(u => u.id === userId);
      if (!user) {
        return { success: false, message: 'User not found.' };
      }
      const currentUser = this.getCurrentUser();
      if (currentUser && currentUser.id === userId) {
        return { success: false, message: 'You cannot change your own role.' };
      }
      const allowedRoles = ['Admin', 'Executor', 'Heir', 'Beneficiary'];
      if (!allowedRoles.includes(newRole)) {
        return { success: false, message: 'Invalid role.' };
      }
      // Prevent removing the last admin
      if (user.role === 'Admin' && newRole !== 'Admin') {
        const adminCount = users.filter(u => u.role === 'Admin').length;
        if (adminCount <= 1) {
          return { success: false, message: 'Cannot remove the last admin.' };
        }
      }
      user.role = newRole;
      this.saveUsers(users);
      return { success: true, message: 'User role updated successfully.' };
    },

    async deleteUser(userId) {
      const users = this.getUsers();
      const user = users.find(u => u.id === userId);
      if (!user) {
        return { success: false, message: 'User not found.' };
      }
      const currentUser = this.getCurrentUser();
      if (currentUser && currentUser.id === userId) {
        return { success: false, message: 'You cannot delete your own account.' };
      }
      if (user.role === 'Admin') {
        return { success: false, message: 'Admin accounts cannot be deleted.' };
      }
      const newUsers = users.filter(u => u.id !== userId);
      this.saveUsers(newUsers);
      return { success: true, message: 'User deleted successfully.' };
    },

    async resetUserPassword(userId, newPassword) {
      const users = this.getUsers();
      const user = users.find(u => u.id === userId);
      if (!user) {
        return { success: false, message: 'User not found.' };
      }
      const hashedPassword = await this.hashPassword(newPassword);
      user.password = hashedPassword;
      this.saveUsers(users);
      return { success: true, message: 'Password reset successfully.' };
    },

    async restoreDefaultUsers() {
      const hashedAdmin = await this.hashPassword('admin');
      const hashedExec = await this.hashPassword('executor');
      const hashedHeir = await this.hashPassword('heir');
      const hashedBen = await this.hashPassword('beneficiary');
      const defaultUsers = [
        { id: 1, username: 'admin', password: hashedAdmin, name: 'System Admin', role: 'Admin', email: 'admin@estatepro.local' },
        { id: 2, username: 'executor', password: hashedExec, name: 'Michael Johnson', role: 'Executor', email: 'michael@email.com' },
        { id: 3, username: 'heir', password: hashedHeir, name: 'Sarah Johnson', role: 'Heir', email: 'sarah@email.com' },
        { id: 4, username: 'beneficiary', password: hashedBen, name: 'David Johnson', role: 'Beneficiary', email: 'david@email.com' }
      ];
      // Merge: keep existing users, only overwrite default usernames
      const existing = this.getUsers();
      const existingMap = new Map(existing.map(u => [u.username, u]));
      defaultUsers.forEach(u => existingMap.set(u.username, u));
      this.saveUsers(Array.from(existingMap.values()));
      return { success: true, message: 'Default users restored. You can now sign in with admin/admin.' };
    },

    async promoteSelfToAdmin() {
      const currentUser = this.getCurrentUser();
      if (!currentUser) {
        return { success: false, message: 'You must be logged in.' };
      }
      const users = this.getUsers();
      const user = users.find(u => u.id === currentUser.id);
      if (!user) {
        return { success: false, message: 'User not found.' };
      }
      if (user.role === 'Admin') {
        return { success: false, message: 'You are already an Admin.' };
      }
      user.role = 'Admin';
      await this.saveUsers(users);
      // Update session so permissions apply immediately
      const session = { ...currentUser, role: 'Admin' };
      localStorage.setItem('estatepro_session', JSON.stringify(session));
      return { success: true, message: 'Your account has been promoted to Admin.' };
    },

    async changeOwnPassword(currentPassword, newPassword) {
      const currentUser = this.getCurrentUser();
      if (!currentUser) {
        return { success: false, message: 'You must be logged in to change your password.' };
      }
      const users = this.getUsers();
      const user = users.find(u => u.id === currentUser.id);
      if (!user) {
        return { success: false, message: 'User not found.' };
      }
      const hashedCurrent = await this.hashPassword(currentPassword);
      if (user.password !== hashedCurrent) {
        return { success: false, message: 'Current password is incorrect.' };
      }
      const hashedNew = await this.hashPassword(newPassword);
      user.password = hashedNew;
      this.saveUsers(users);
      return { success: true, message: 'Password changed successfully.' };
    }
  },

  /* ============================
     PERMISSIONS
     ============================ */
  Permissions: {
    canEdit() {
      const user = App.Auth.getCurrentUser();
      if (!user) return false;
      return user.role === 'Admin' || user.role === 'Executor';
    },

    canManageUsers() {
      const user = App.Auth.getCurrentUser();
      if (!user) return false;
      return user.role === 'Admin';
    },

    canView() {
      return App.Auth.isLoggedIn();
    },

    getRoleLabel(role) {
      const labels = { Admin: 'Administrator', Executor: 'Executor', Heir: 'Heir', Beneficiary: 'Beneficiary' };
      return labels[role] || role;
    }
  },

  /* ============================
     CRYPTO
     ============================ */
  Crypto: {
    _passphrase: null,
    _key: null,

    _arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    },

    _base64ToArrayBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    },

    async _deriveKey(passphrase, salt) {
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
      );
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    },

    async _getKey(passphrase) {
      if (this._key) return this._key;
      const keySaltRaw = localStorage.getItem('estatepro_key_salt');
      const salt = keySaltRaw ? this._base64ToArrayBuffer(keySaltRaw) : new Uint8Array(16);
      this._key = await this._deriveKey(passphrase, salt);
      return this._key;
    },

    clearKeyCache() {
      this._key = null;
    },

    async encrypt(plaintext, passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await this._getKey(passphrase);
      const encoder = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, encoder.encode(plaintext)
      );
      return {
        v: 1,
        salt: this._arrayBufferToBase64(salt),
        iv: this._arrayBufferToBase64(iv),
        ct: this._arrayBufferToBase64(ciphertext),
        algo: 'AES-GCM-256-PBKDF2'
      };
    },

    async decrypt(envelope, passphrase) {
      const iv = this._base64ToArrayBuffer(envelope.iv);
      const ct = this._base64ToArrayBuffer(envelope.ct);
      const keySaltRaw = localStorage.getItem('estatepro_key_salt');
      if (keySaltRaw) {
        const key = await this._getKey(passphrase);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(decrypted);
      }
      // Fallback: old data encrypted without a fixed key salt
      const salt = this._base64ToArrayBuffer(envelope.salt);
      const key = await this._deriveKey(passphrase, salt);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(decrypted);
    },

    isEncryptionEnabled() {
      return localStorage.getItem('estatepro_encrypted') === 'true';
    },

    async readStorage(key) {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ct && parsed.algo) {
          const passphrase = this._passphrase;
          if (!passphrase) {
            throw new Error('Passphrase required to decrypt data');
          }
          const decrypted = await this.decrypt(parsed, passphrase);
          return JSON.parse(decrypted);
        }
        return parsed;
      } catch (e) {
        return null;
      }
    },

    async writeStorage(key, value) {
      if (this.isEncryptionEnabled() && this._passphrase) {
        const envelope = await this.encrypt(JSON.stringify(value), this._passphrase);
        localStorage.setItem(key, JSON.stringify(envelope));
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    },

    async setPassphrase(passphrase) {
      this._passphrase = passphrase;
      try {
        await this._getKey(passphrase);
      } catch (e) {
        this._key = null;
      }
    },

    loadPassphraseFromSession() {
      try {
        const stored = sessionStorage.getItem('estatepro_passphrase');
        if (stored) {
          this._passphrase = stored;
          return true;
        }
      } catch (e) { /* sessionStorage may be unavailable */ }
      return false;
    },

    savePassphraseToSession() {
      try {
        if (this._passphrase) {
          sessionStorage.setItem('estatepro_passphrase', this._passphrase);
        } else {
          sessionStorage.removeItem('estatepro_passphrase');
        }
      } catch (e) { /* sessionStorage may be unavailable */ }
    },

    clearPassphraseFromSession() {
      try {
        sessionStorage.removeItem('estatepro_passphrase');
      } catch (e) { /* sessionStorage may be unavailable */ }
    },

    getPassphrase() {
      return this._passphrase;
    },

    hasPassphrase() {
      return !!this._passphrase;
    },

    async verifyPassphrase(passphrase) {
      const raw = localStorage.getItem('estatepro_key_verify');
      if (!raw) return false;
      try {
        const envelope = JSON.parse(raw);
        const iv = this._base64ToArrayBuffer(envelope.iv);
        const ct = this._base64ToArrayBuffer(envelope.ct);
        const keySaltRaw = localStorage.getItem('estatepro_key_salt');
        let key;
        if (keySaltRaw) {
          const salt = this._base64ToArrayBuffer(keySaltRaw);
          key = await this._deriveKey(passphrase, salt);
        } else {
          const salt = this._base64ToArrayBuffer(envelope.salt);
          key = await this._deriveKey(passphrase, salt);
        }
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv }, key, ct
        );
        return new TextDecoder().decode(decrypted) === 'EstatePro:v1';
      } catch (e) {
        return false;
      }
    },

    async setupEncryption(passphrase) {
      const estate = App.Data.getEstate();
      const users = App.Auth.getUsers();
      this._passphrase = passphrase;
      // Generate and store a fixed key derivation salt
      const keySalt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem('estatepro_key_salt', this._arrayBufferToBase64(keySalt));
      this._key = await this._deriveKey(passphrase, keySalt);
      const verifyEnvelope = await this.encrypt('EstatePro:v1', passphrase);
      localStorage.setItem('estatepro_key_verify', JSON.stringify(verifyEnvelope));
      localStorage.setItem('estatepro_encrypted', 'true');
      await this.writeStorage('estatepro_estate', estate);
      await this.writeStorage('estatepro_users', users);
      return { success: true, message: 'Encryption enabled. All data is now encrypted.' };
    },

    async changePassphrase(oldPassphrase, newPassphrase) {
      if (!await this.verifyPassphrase(oldPassphrase)) {
        return { success: false, message: 'Current passphrase is incorrect.' };
      }
      const estate = await this.readStorage('estatepro_estate');
      const users = await this.readStorage('estatepro_users');
      this._passphrase = newPassphrase;
      this._key = null;
      await this._getKey(newPassphrase);
      const verifyEnvelope = await this.encrypt('EstatePro:v1', newPassphrase);
      localStorage.setItem('estatepro_key_verify', JSON.stringify(verifyEnvelope));
      await this.writeStorage('estatepro_estate', estate);
      await this.writeStorage('estatepro_users', users);
      return { success: true, message: 'Passphrase changed successfully.' };
    },

    async disableEncryption(passphrase) {
      if (!await this.verifyPassphrase(passphrase)) {
        return { success: false, message: 'Passphrase is incorrect.' };
      }
      const estate = await this.readStorage('estatepro_estate');
      const users = await this.readStorage('estatepro_users');
      localStorage.removeItem('estatepro_encrypted');
      localStorage.removeItem('estatepro_key_verify');
      localStorage.removeItem('estatepro_key_salt');
      this._passphrase = null;
      this._key = null;
      localStorage.setItem('estatepro_estate', JSON.stringify(estate));
      localStorage.setItem('estatepro_users', JSON.stringify(users));
      return { success: true, message: 'Encryption disabled. Data is now stored in plaintext.' };
    },

    async init() {
      if (this.isEncryptionEnabled() && !this.hasPassphrase()) {
        return new Promise((resolve) => {
          App.UI.showPassphraseModal(async () => {
            await App.Data.init();
            await App.Auth.init();
            resolve();
          });
        });
      }
      await App.Data.init();
      await App.Auth.init();
    }
  },

  /* ============================
     DATA MANAGEMENT
     ============================ */
  Data: {
    _cache: null,

    async init() {
      let estate = await App.Crypto.readStorage('estatepro_estate');
      if (!estate) {
        estate = this.getSeedData();
        await App.Crypto.writeStorage('estatepro_estate', estate);
      } else {
        // Migrate missing fields for existing data
        let migrated = false;
        let seed = null;
        if (estate.decedent && !estate.decedent.documents) {
          seed = seed || this.getSeedData();
          estate.decedent.documents = seed.decedent.documents;
          migrated = true;
        }
        if (estate.executor && !estate.executor.documents) {
          seed = seed || this.getSeedData();
          estate.executor.documents = seed.executor.documents;
          migrated = true;
        }
        if (migrated) {
          await App.Crypto.writeStorage('estatepro_estate', estate);
        }
      }
      this._cache = estate;
    },

    getEstate() {
      if (this._cache) return this._cache;
      // Legacy fallback for plaintext or pre-init state
      let estate = null;
      try {
        const raw = localStorage.getItem('estatepro_estate');
        if (!raw) return this.getSeedData();
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ct && parsed.algo) {
          // Encrypted but not yet decrypted — return safe empty structure
          return this.getEmptyEstate();
        }
        estate = parsed;
      } catch (e) { /* ignore */ }
      if (!estate) {
        estate = this.getSeedData();
        this.saveEstate(estate);
      }
      return estate;
    },

    getEmptyEstate() {
      return JSON.parse(JSON.stringify({
        decedent: {},
        executor: {},
        tasks: [],
        assets: [],
        debts: [],
        cashflow: [],
        heirs: [],
        distributions: []
      }));
    },

    async reloadFromStorage() {
      const estate = await App.Crypto.readStorage('estatepro_estate');
      if (estate) {
        this._cache = estate;
      }
    },

    saveEstate(estate) {
      this._cache = estate;
      App.Crypto.writeStorage('estatepro_estate', estate).catch(err => console.error('Failed to save estate:', err));
    },

    resetData() {
      const estate = this.getSeedData();
      this.saveEstate(estate);
      return estate;
    },

    getSeedData() {
      return {
        decedent: {
          name: 'Mom',
          fullName: 'Margaret Elizabeth Johnson',
          dateOfBirth: '1945-03-15',
          dateOfDeath: '2024-01-10',
          ssn: '***-**-1234',
          address: '123 Maple Street, Springfield, IL 62701',
          stateOfResidence: 'Illinois',
          countyOfResidence: 'Sangamon',
          maritalStatus: 'Widowed',
          willLocation: 'Safe deposit box at First National Bank',
          executorNamed: 'Yes - Michael Johnson (eldest son)',
          placeOfDeath: 'Springfield General Hospital',
          funeralHome: 'Springfield Memorial Funeral Home',
          obituaryPublished: 'Yes - Springfield Gazette, Jan 12, 2024',
          documents: [
            { id: 1, name: 'Original Will', status: 'Found', notes: 'Located in safe deposit box', dueDate: '2024-02-01', assignedTo: 'Michael Johnson' },
            { id: 2, name: 'Death Certificates', status: 'Found', notes: '10 certified copies ordered', dueDate: '2024-01-20', assignedTo: 'Michael Johnson' },
            { id: 3, name: 'Safe Deposit Box Key', status: 'Found', notes: 'Key found in desk drawer', dueDate: '2024-01-15', assignedTo: 'Sarah Johnson' },
            { id: 4, name: 'Trust Documents', status: 'Missing', notes: 'Checking with attorney', dueDate: '2024-03-01', assignedTo: 'Robert Chen (Attorney)' },
            { id: 5, name: 'Life Insurance Policies', status: 'Found', notes: 'State Farm policy #LF-9988776', dueDate: '2024-02-15', assignedTo: 'Michael Johnson' },
            { id: 6, name: 'Pension / Retirement Docs', status: 'Missing', notes: 'Vanguard IRA statements pending', dueDate: '2024-03-15', assignedTo: 'David Johnson' },
            { id: 7, name: 'Property Deeds', status: 'Found', notes: 'Primary residence deed', dueDate: '2024-02-01', assignedTo: 'Michael Johnson' },
            { id: 8, name: 'Vehicle Titles', status: 'Found', notes: '2019 Honda Accord', dueDate: '2024-02-01', assignedTo: 'Sarah Johnson' }
          ]
        },
        executor: {
          name: 'Michael Johnson',
          relationship: 'Son',
          address: '456 Oak Avenue, Springfield, IL 62701',
          phone: '(217) 555-0123',
          email: 'michael.johnson@email.com',
          dateAppointed: '2024-01-25',
          courtName: 'Sangamon County Probate Court',
          caseNumber: '2024-PR-00142',
          bondAmount: 50000,
          bondPosted: true,
          attorneyName: 'Robert Chen, Esq.',
          attorneyPhone: '(217) 555-0198',
          attorneyEmail: 'rchen@chenlaw.com',
          notes: 'EIN obtained: 37-1234567. Letters testamentary issued Jan 25, 2024.',
          documents: [
            { id: 1, name: 'Letters Testamentary', status: 'Found', notes: 'Issued Jan 25, 2024 by Sangamon County', dueDate: '2024-02-01', assignedTo: 'Michael Johnson' },
            { id: 2, name: 'Bond Receipt / Certificate', status: 'Found', notes: 'Surety bond $50,000 posted with Illinois Bonding Co.', dueDate: '2024-02-01', assignedTo: 'Michael Johnson' },
            { id: 3, name: 'EIN Confirmation Letter', status: 'Found', notes: 'IRS SS-4 confirmation received, EIN 37-1234567', dueDate: '2024-02-05', assignedTo: 'Michael Johnson' },
            { id: 4, name: 'Petition for Probate Filing', status: 'Found', notes: 'Filed Jan 22, 2024 with county clerk', dueDate: '2024-01-25', assignedTo: 'Robert Chen (Attorney)' },
            { id: 5, name: 'Oath of Executor', status: 'Found', notes: 'Signed and filed with probate court', dueDate: '2024-01-25', assignedTo: 'Michael Johnson' },
            { id: 6, name: 'Notice to Creditors Publication', status: 'Found', notes: 'Published in Springfield Gazette, 3 consecutive weeks', dueDate: '2024-02-15', assignedTo: 'Robert Chen (Attorney)' },
            { id: 7, name: 'Inventory & Appraisal Filing', status: 'Missing', notes: 'Due within 90 days of appointment; gathering appraisals', dueDate: '2024-04-25', assignedTo: 'Michael Johnson' },
            { id: 8, name: 'Final Accounting & Report', status: 'Missing', notes: 'To be prepared after all distributions complete', dueDate: '2024-08-01', assignedTo: 'Robert Chen (Attorney)' }
          ]
        },
        tasks: [
          { id: 1, title: 'Obtain certified copies of death certificate', category: 'Immediate', priority: 'High', status: 'Completed', dueDate: '2024-01-15', completedDate: '2024-01-12', notes: 'Ordered 10 copies from Vital Records' },
          { id: 2, title: 'Locate the will and other estate planning documents', category: 'Immediate', priority: 'High', status: 'Completed', dueDate: '2024-01-15', completedDate: '2024-01-11', notes: 'Found in safe deposit box at First National Bank' },
          { id: 3, title: 'Secure the decedent\'s property and assets', category: 'Immediate', priority: 'High', status: 'Completed', dueDate: '2024-01-20', completedDate: '2024-01-14', notes: 'Changed locks on residence, secured vehicle and valuables' },
          { id: 4, title: 'Notify Social Security Administration', category: 'Immediate', priority: 'High', status: 'Completed', dueDate: '2024-01-20', completedDate: '2024-01-16', notes: 'Called SSA, benefits stopped effective Jan 2024' },
          { id: 5, title: 'File petition for probate with county court', category: 'Probate', priority: 'High', status: 'Completed', dueDate: '2024-02-01', completedDate: '2024-01-22', notes: 'Filed with Sangamon County Probate Court' },
          { id: 6, title: 'Publish notice to creditors in local newspaper', category: 'Probate', priority: 'High', status: 'Completed', dueDate: '2024-02-15', completedDate: '2024-02-05', notes: 'Published in Springfield Gazette for 3 consecutive weeks' },
          { id: 7, title: 'Notify all known creditors of estate', category: 'Probate', priority: 'Medium', status: 'Completed', dueDate: '2024-02-20', completedDate: '2024-02-10', notes: 'Sent certified letters to all known creditors' },
          { id: 8, title: 'Obtain Employer Identification Number (EIN) for estate', category: 'Financial', priority: 'High', status: 'Completed', dueDate: '2024-02-01', completedDate: '2024-01-26', notes: 'EIN: 37-1234567' },
          { id: 9, title: 'Open estate checking account', category: 'Financial', priority: 'High', status: 'Completed', dueDate: '2024-02-05', completedDate: '2024-01-30', notes: 'Opened at First National Bank' },
          { id: 10, title: 'File decedent\'s final income tax return', category: 'Financial', priority: 'High', status: 'In Progress', dueDate: '2024-04-15', completedDate: '', notes: 'Gathering documents for accountant' },
          { id: 11, title: 'File estate income tax return (Form 1041)', category: 'Financial', priority: 'Medium', status: 'Pending', dueDate: '2024-04-15', completedDate: '', notes: 'Will file after fiscal year close' },
          { id: 12, title: 'Inventory and appraise all estate assets', category: 'Financial', priority: 'High', status: 'In Progress', dueDate: '2024-03-01', completedDate: '', notes: 'Awaiting appraisal for home and jewelry' },
          { id: 13, title: 'Pay valid creditor claims', category: 'Financial', priority: 'High', status: 'In Progress', dueDate: '2024-04-01', completedDate: '', notes: 'Paying monthly mortgage and utilities from estate account' },
          { id: 14, title: 'Sell or distribute personal property', category: 'Distribution', priority: 'Medium', status: 'Pending', dueDate: '2024-06-01', completedDate: '', notes: 'Heirs to select items before estate sale' },
          { id: 15, title: 'Distribute remaining assets to heirs', category: 'Distribution', priority: 'Medium', status: 'Pending', dueDate: '2024-07-01', completedDate: '', notes: 'After debts and taxes are resolved' },
          { id: 16, title: 'File final accounting with probate court', category: 'Probate', priority: 'Medium', status: 'Pending', dueDate: '2024-08-01', completedDate: '', notes: 'Will prepare after all transactions complete' },
          { id: 17, title: 'Close probate case', category: 'Probate', priority: 'Low', status: 'Pending', dueDate: '2024-09-01', completedDate: '', notes: 'Final step after all distributions made' }
        ],
        assets: [
          { id: 1, name: 'Primary Residence', category: 'Real Estate', description: '123 Maple Street, Springfield, IL', value: 285000, dateAcquired: '1985-06-01', ownership: 'Sole', status: 'Active', notes: 'Paid off, no mortgage. Market appraisal pending.' },
          { id: 2, name: '2019 Honda Accord', category: 'Vehicle', description: 'White, 45,000 miles, VIN: 1HGCV1F3XKA123456', value: 18500, dateAcquired: '2019-03-10', ownership: 'Sole', status: 'Active', notes: 'In good condition, garaged at residence' },
          { id: 3, name: 'First National Bank Checking', category: 'Bank Account', description: 'Account ending in 4521', value: 12450.75, dateAcquired: '1975-01-01', ownership: 'Sole', status: 'Active', notes: 'Estate account opened. Joint account with Michael transferred.' },
          { id: 4, name: 'First National Bank Savings', category: 'Bank Account', description: 'Account ending in 7893', value: 45600.00, dateAcquired: '1980-05-01', ownership: 'Sole', status: 'Active', notes: 'Estate account opened.' },
          { id: 5, name: 'Fidelity Investment Account', category: 'Investment', description: 'Account #88723456', value: 187500.00, dateAcquired: '2000-01-01', ownership: 'Sole', status: 'Active', notes: 'Mix of stocks and bonds. Brokerage statements available.' },
          { id: 6, name: 'IRA - Vanguard', category: 'Retirement', description: 'Traditional IRA', value: 245000.00, dateAcquired: '1990-01-01', ownership: 'Sole', status: 'Active', notes: 'Named beneficiaries: Michael, Sarah, David (equal shares)' },
          { id: 7, name: 'Life Insurance - State Farm', category: 'Insurance', description: 'Policy #LF-9988776', value: 100000.00, dateAcquired: '1995-01-01', ownership: 'Sole', status: 'Active', notes: 'Beneficiary: Michael Johnson (executor). Claim filed.' },
          { id: 8, name: 'Household Furniture & Appliances', category: 'Personal Property', description: 'Living room, dining room, bedroom sets, kitchen appliances', value: 15000.00, dateAcquired: '2000-01-01', ownership: 'Sole', status: 'Active', notes: 'To be distributed among heirs or sold at estate sale' },
          { id: 9, name: 'Jewelry Collection', category: 'Personal Property', description: 'Wedding rings, necklaces, bracelets, watches', value: 25000.00, dateAcquired: '1970-01-01', ownership: 'Sole', status: 'Active', notes: 'Professional appraisal scheduled. Includes family heirlooms.' },
          { id: 10, name: 'Electronics & Media', category: 'Personal Property', description: 'TV, computer, stereo, books, records', value: 3500.00, dateAcquired: '2010-01-01', ownership: 'Sole', status: 'Active', notes: 'Flat screen TV, desktop computer, extensive book collection' }
        ],
        debts: [
          { id: 1, name: 'Chase Bank Credit Card', category: 'Credit Card', creditor: 'Chase Bank', balance: 2340.50, interestRate: 18.99, minPayment: 75.00, status: 'Active', notes: 'Used for household expenses. Balance as of Jan 2024.' },
          { id: 2, name: 'Springfield General Hospital', category: 'Medical', creditor: 'Springfield General Hospital', balance: 8750.00, interestRate: 0, minPayment: 0, status: 'Active', notes: 'Final medical bills from hospital stay. Insurance pending.' },
          { id: 3, name: 'Dr. Patricia Williams', category: 'Medical', creditor: 'Dr. Patricia Williams', balance: 450.00, interestRate: 0, minPayment: 0, status: 'Active', notes: 'Outstanding physician bill.' },
          { id: 4, name: 'Springfield Memorial Funeral Home', category: 'Funeral', creditor: 'Springfield Memorial Funeral Home', balance: 8500.00, interestRate: 0, minPayment: 0, status: 'Paid', notes: 'Funeral services and cremation. Paid from estate account Jan 20.' },
          { id: 5, name: 'City of Springfield - Utilities', category: 'Utility', creditor: 'City of Springfield', balance: 180.00, interestRate: 0, minPayment: 0, status: 'Active', notes: 'Final utility bill for residence. Service transferred to estate.' },
          { id: 6, name: 'Attorney Fees - Robert Chen', category: 'Legal', creditor: 'Chen & Associates Law', balance: 3500.00, interestRate: 0, minPayment: 0, status: 'Active', notes: 'Probate attorney retainer. Hourly billing at $275/hr.' },
          { id: 7, name: 'Illinois Dept of Revenue', category: 'Tax', creditor: 'Illinois Dept of Revenue', balance: 0, interestRate: 0, minPayment: 0, status: 'Pending', notes: 'No known state tax liability. Will confirm with accountant.' },
          { id: 8, name: 'IRS - Final Income Tax', category: 'Tax', creditor: 'Internal Revenue Service', balance: 0, interestRate: 0, minPayment: 0, status: 'Pending', notes: 'Final return being prepared. Refund or balance TBD.' }
        ],
        cashflow: [
          { id: 1, date: '2024-01-15', type: 'Income', category: 'Pension', description: 'Monthly pension payment - prorated', amount: 1050.00, account: 'Checking', cleared: true },
          { id: 2, date: '2024-01-20', type: 'Expense', category: 'Funeral', description: 'Funeral services and cremation', amount: 8500.00, account: 'Checking', cleared: true },
          { id: 3, date: '2024-01-25', type: 'Income', category: 'Life Insurance', description: 'State Farm life insurance payout', amount: 100000.00, account: 'Checking', cleared: true },
          { id: 4, date: '2024-01-28', type: 'Expense', category: 'Legal', description: 'Attorney retainer deposit', amount: 2000.00, account: 'Checking', cleared: true },
          { id: 5, date: '2024-02-01', type: 'Income', category: 'Interest', description: 'Savings account interest', amount: 125.00, account: 'Savings', cleared: true },
          { id: 6, date: '2024-02-05', type: 'Expense', category: 'Medical', description: 'Hospital co-payment and deductibles', amount: 1250.00, account: 'Checking', cleared: true },
          { id: 7, date: '2024-02-10', type: 'Expense', category: 'Utility', description: 'Utilities - residence (Jan)', amount: 340.00, account: 'Checking', cleared: true },
          { id: 8, date: '2024-02-15', type: 'Income', category: 'Dividend', description: 'Fidelity dividend payment', amount: 875.00, account: 'Checking', cleared: true },
          { id: 9, date: '2024-02-20', type: 'Expense', category: 'Maintenance', description: 'Home maintenance and lawn care', amount: 450.00, account: 'Checking', cleared: true },
          { id: 10, date: '2024-02-28', type: 'Expense', category: 'Insurance', description: 'Homeowners insurance (6 months)', amount: 920.00, account: 'Checking', cleared: true },
          { id: 11, date: '2024-03-05', type: 'Expense', category: 'Medical', description: 'Physician bill - Dr. Williams', amount: 450.00, account: 'Checking', cleared: true },
          { id: 12, date: '2024-03-10', type: 'Income', category: 'Interest', description: 'Savings account interest', amount: 132.00, account: 'Savings', cleared: true },
          { id: 13, date: '2024-03-15', type: 'Expense', category: 'Credit Card', description: 'Credit card payment - Chase', amount: 750.00, account: 'Checking', cleared: true },
          { id: 14, date: '2024-03-20', type: 'Expense', category: 'Tax', description: 'Property tax - 1st installment', amount: 2100.00, account: 'Checking', cleared: true },
          { id: 15, date: '2024-03-25', type: 'Expense', category: 'Legal', description: 'Attorney fees - probate filing', amount: 1500.00, account: 'Checking', cleared: true }
        ],
        heirs: [
          { id: 1, name: 'Michael Johnson', relationship: 'Son', address: '456 Oak Avenue, Springfield, IL 62701', phone: '(217) 555-0123', email: 'michael.johnson@email.com', ssn: '***-**-5678', share: 40, status: 'Active', notes: 'Named executor. Will receive 40% of residuary estate plus primary residence if desired.' },
          { id: 2, name: 'Sarah Johnson', relationship: 'Daughter', address: '789 Pine Road, Chicago, IL 60601', phone: '(312) 555-0456', email: 'sarah.johnson@email.com', ssn: '***-**-9012', share: 30, status: 'Active', notes: 'Lives in Chicago. Will receive 30% of residuary estate.' },
          { id: 3, name: 'David Johnson', relationship: 'Son', address: '321 Elm Street, Peoria, IL 61602', phone: '(309) 555-0789', email: 'david.johnson@email.com', ssn: '***-**-3456', share: 30, status: 'Active', notes: 'Lives in Peoria. Will receive 30% of residuary estate.' },
          { id: 4, name: 'St. Jude Children\'s Research Hospital', relationship: 'Charity', address: '262 Danny Thomas Place, Memphis, TN 38105', phone: '(901) 555-0100', email: 'donations@stjude.org', ssn: '', share: 0, status: 'Active', notes: 'Named to receive $10,000 bequest from checking account.' }
        ],
        distributions: [
          { id: 1, heirId: 1, heirName: 'Michael Johnson', assetId: null, assetName: 'Cash - Residuary Share', amount: 156000, date: '', status: 'Planned', notes: '40% of residuary estate after debts and expenses paid' },
          { id: 2, heirId: 2, heirName: 'Sarah Johnson', assetId: null, assetName: 'Cash - Residuary Share', amount: 117000, date: '', status: 'Planned', notes: '30% of residuary estate after debts and expenses paid' },
          { id: 3, heirId: 3, heirName: 'David Johnson', assetId: null, assetName: 'Cash - Residuary Share', amount: 117000, date: '', status: 'Planned', notes: '30% of residuary estate after debts and expenses paid' },
          { id: 4, heirId: 4, heirName: 'St. Jude Children\'s Research Hospital', assetId: null, assetName: 'Cash - Bequest', amount: 10000, date: '', status: 'Planned', notes: 'Specific bequest from estate checking account' },
          { id: 5, heirId: 1, heirName: 'Michael Johnson', assetId: 1, assetName: 'Primary Residence (if desired)', amount: 285000, date: '', status: 'Pending', notes: 'Option to purchase at appraised value or share proceeds with siblings' },
          { id: 6, heirId: 2, heirName: 'Sarah Johnson', assetId: 8, assetName: 'Household Furniture & Appliances', amount: 15000, date: '', status: 'Pending', notes: 'Sarah has expressed interest in dining room set and kitchen items' },
          { id: 7, heirId: 3, heirName: 'David Johnson', assetId: 9, assetName: 'Jewelry Collection', amount: 25000, date: '', status: 'Pending', notes: 'David to select items before appraisal; remainder sold at estate sale' }
        ]
      };
    },

    getNextId(array) {
      if (!array || array.length === 0) return 1;
      return Math.max(...array.map(item => item.id || 0)) + 1;
    }
  },

  /* ============================
     EXPORT
     ============================ */
  Export: {
    toCSV(data, filename) {
      if (!data || data.length === 0) return;
      const headers = Object.keys(data[0]);
      const csvContent = [
        headers.join(','),
        ...data.map(row =>
          headers.map(h => {
            let val = row[h] ?? '';
            val = String(val).replace(/"/g, '""');
            if (val.includes(',') || val.includes('\n') || val.includes('"')) {
              val = `"${val}"`;
            }
            return val;
          }).join(',')
        )
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    },

    printPDF() {
      window.print();
    }
  },

  /* ============================
     BACKUP REMINDER
     ============================ */
  BackupReminder: {
    getLastBackup() {
      return localStorage.getItem('estatepro_last_backup');
    },

    setLastBackup() {
      localStorage.setItem('estatepro_last_backup', new Date().toISOString());
    },

    getDismissedUntil() {
      const val = localStorage.getItem('estatepro_backup_dismissed');
      return val ? parseInt(val, 10) : 0;
    },

    setDismissedUntil(hours) {
      const ms = hours * 60 * 60 * 1000;
      localStorage.setItem('estatepro_backup_dismissed', String(Date.now() + ms));
    },

    getReminderInterval() {
      const val = localStorage.getItem('estatepro_backup_interval');
      const defaultInterval = 7 * 24 * 60 * 60 * 1000;
      if (!val) return defaultInterval;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? defaultInterval : parsed;
    },

    setReminderInterval(days) {
      localStorage.setItem('estatepro_backup_interval', String(days * 24 * 60 * 60 * 1000));
    },

    shouldShowReminder() {
      if (!App.Auth.isLoggedIn()) return false;
      const lastBackup = this.getLastBackup();
      const dismissedUntil = this.getDismissedUntil();
      const now = Date.now();
      if (dismissedUntil > now) return false;
      const interval = this.getReminderInterval();
      if (!lastBackup) return true;
      const lastBackupTime = new Date(lastBackup).getTime();
      return (now - lastBackupTime) > interval;
    },

    getDaysSinceLastBackup() {
      const lastBackup = this.getLastBackup();
      if (!lastBackup) return Infinity;
      const diff = Date.now() - new Date(lastBackup).getTime();
      return Math.floor(diff / (1000 * 60 * 60 * 24));
    }
  },

  /* ============================
     SYNC - JSON EXPORT/IMPORT
     ============================ */
  Sync: {
    getExportData() {
      const estate = App.Data.getEstate();
      const users = App.Auth.getUsers();
      const session = App.Auth.getCurrentUser();
      const darkMode = localStorage.getItem('estatepro_darkmode');
      return {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        exportedBy: session ? session.username : 'unknown',
        estate: estate,
        users: users,
        preferences: {
          darkMode: darkMode === 'true'
        }
      };
    },

    async exportAll() {
      const data = this.getExportData();
      let exportContent;
      if (App.Crypto.isEncryptionEnabled() && App.Crypto.hasPassphrase()) {
        const envelope = await App.Crypto.encrypt(JSON.stringify(data, null, 2), App.Crypto.getPassphrase());
        exportContent = JSON.stringify(envelope, null, 2);
      } else {
        exportContent = JSON.stringify(data, null, 2);
      }
      const blob = new Blob([exportContent], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      link.download = `estatepro-backup-${date}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      App.BackupReminder.setLastBackup();
    },

    async exportEstateOnly() {
      const estate = App.Data.getEstate();
      let exportContent;
      if (App.Crypto.isEncryptionEnabled() && App.Crypto.hasPassphrase()) {
        const envelope = await App.Crypto.encrypt(JSON.stringify(estate, null, 2), App.Crypto.getPassphrase());
        exportContent = JSON.stringify(envelope, null, 2);
      } else {
        exportContent = JSON.stringify(estate, null, 2);
      }
      const blob = new Blob([exportContent], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      link.download = `estatepro-estate-${date}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      App.BackupReminder.setLastBackup();
    },

    validateImportData(data) {
      if (!data || typeof data !== 'object') return { valid: false, error: 'Invalid JSON file' };
      if (!data.estate && !data.assets) return { valid: false, error: 'No estate data found in file' };
      if (data.estate && typeof data.estate === 'object') {
        return { valid: true, hasUsers: !!data.users, isFullBackup: true, data: data };
      }
      if (data.assets && Array.isArray(data.assets)) {
        return { valid: true, hasUsers: false, isFullBackup: false, data: { estate: data } };
      }
      return { valid: false, error: 'Unrecognized data format' };
    },

    async importFromFile(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            let json = JSON.parse(e.target.result);
            // Check if it's an encrypted backup envelope
            if (json && json.ct && json.algo) {
              const passphrase = App.Crypto.getPassphrase();
              if (!passphrase) {
                resolve({ success: false, message: 'This backup is encrypted. Please enter your passphrase first (via the Security tab in Sync & Share).' });
                return;
              }
              try {
                const decrypted = await App.Crypto.decrypt(json, passphrase);
                json = JSON.parse(decrypted);
              } catch (err) {
                resolve({ success: false, message: 'Failed to decrypt backup: ' + err.message });
                return;
              }
            }
            const validation = this.validateImportData(json);
            if (!validation.valid) {
              resolve({ success: false, message: validation.error });
              return;
            }
            resolve({ success: true, validation: validation });
          } catch (err) {
            resolve({ success: false, message: 'Invalid JSON file: ' + err.message });
          }
        };
        reader.onerror = () => {
          resolve({ success: false, message: 'Failed to read file' });
        };
        reader.readAsText(file);
      });
    },

    applyImport(validation, options = {}) {
      const { data, isFullBackup } = validation;
      try {
        if (data.estate) {
          App.Data.saveEstate(data.estate);
        }
        if (options.includeUsers && isFullBackup && data.users && Array.isArray(data.users)) {
          const localUsers = App.Auth.getUsers();
          const localUsersMap = new Map(localUsers.map(u => [u.username, u]));
          data.users.forEach(backupUser => {
            localUsersMap.set(backupUser.username, backupUser);
          });
          App.Auth.saveUsers(Array.from(localUsersMap.values()));
        }
        if (isFullBackup && data.preferences && data.preferences.darkMode !== undefined) {
          localStorage.setItem('estatepro_darkmode', String(data.preferences.darkMode));
          if (data.preferences.darkMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
          App.DarkMode.updateToggleIcon();
        }
        return { success: true, message: 'Data imported successfully. The page will refresh.' };
      } catch (err) {
        return { success: false, message: 'Import failed: ' + err.message };
      }
    }
  },

  /* ============================
     GIST - GITHUB GIST SYNC
     ============================ */
  Gist: {
    getConfig() {
      try {
        return JSON.parse(localStorage.getItem('estatepro_gist_config')) || {};
      } catch (e) {
        return {};
      }
    },

    saveConfig(config) {
      localStorage.setItem('estatepro_gist_config', JSON.stringify(config));
    },

    getLastSyncTime() {
      return localStorage.getItem('estatepro_last_sync');
    },

    saveLastSyncTime() {
      localStorage.setItem('estatepro_last_sync', new Date().toISOString());
    },

    async loadFromGist(token, gistId) {
      const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `GitHub API error: ${response.status}`);
      }
      const gist = await response.json();
      const file = gist.files && gist.files['estatepro-backup.json'];
      if (!file || !file.content) {
        throw new Error('No estate data found in this Gist');
      }
      let data;
      try {
        const parsed = JSON.parse(file.content);
        if (parsed && parsed.ct && parsed.algo) {
          const passphrase = App.Crypto.getPassphrase();
          if (!passphrase) {
            throw new Error('This Gist backup is encrypted. Please enter your passphrase first.');
          }
          const decrypted = await App.Crypto.decrypt(parsed, passphrase);
          data = JSON.parse(decrypted);
        } else {
          data = parsed;
        }
      } catch (e) {
        throw new Error('Invalid backup data: ' + e.message);
      }
      return { gist: gist, data: data };
    },

    async saveToGist(token, gistId, data) {
      let exportContent;
      if (App.Crypto.isEncryptionEnabled() && App.Crypto.hasPassphrase()) {
        const envelope = await App.Crypto.encrypt(JSON.stringify(data, null, 2), App.Crypto.getPassphrase());
        exportContent = JSON.stringify(envelope, null, 2);
      } else {
        exportContent = JSON.stringify(data, null, 2);
      }
      const payload = {
        files: {
          'estatepro-backup.json': {
            content: exportContent
          }
        }
      };
      const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `GitHub API error: ${response.status}`);
      }
      App.BackupReminder.setLastBackup();
      return await response.json();
    },

    async createGist(token, data) {
      let exportContent;
      if (App.Crypto.isEncryptionEnabled() && App.Crypto.hasPassphrase()) {
        const envelope = await App.Crypto.encrypt(JSON.stringify(data, null, 2), App.Crypto.getPassphrase());
        exportContent = JSON.stringify(envelope, null, 2);
      } else {
        exportContent = JSON.stringify(data, null, 2);
      }
      const payload = {
        description: 'EstatePro Estate Backup',
        public: false,
        files: {
          'estatepro-backup.json': {
            content: exportContent
          }
        }
      };
      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `GitHub API error: ${response.status}`);
      }
      const gist = await response.json();
      App.BackupReminder.setLastBackup();
      return gist.id;
    }
  },

  /* ============================
     DARK MODE
     ============================ */
  DarkMode: {
    init() {
      const saved = localStorage.getItem('estatepro_darkmode');
      if (saved === 'true') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
      this.updateToggleIcon();
    },

    toggle() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('estatepro_darkmode', 'false');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('estatepro_darkmode', 'true');
      }
      this.updateToggleIcon();
    },

    updateToggleIcon() {
      const btn = document.getElementById('darkModeToggle');
      if (!btn) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.innerHTML = isDark ? this.getSunIcon() : this.getMoonIcon();
      btn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    },

    getMoonIcon() {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
    },

    getSunIcon() {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    }
  },

  /* ============================
     UI HELPERS
     ============================ */
  UI: {
    init() {
      // Sidebar navigation highlighting
      const currentPage = window.location.pathname.split('/').pop() || 'index.html';
      document.querySelectorAll('.sidebar-nav a').forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage || (currentPage === '' && href === 'index.html')) {
          link.classList.add('active');
        }
      });

      // Dark mode
      App.DarkMode.init();
      const darkModeBtn = document.getElementById('darkModeToggle');
      if (darkModeBtn) {
        darkModeBtn.addEventListener('click', () => App.DarkMode.toggle());
      }

      // Mobile sidebar toggle
      const mobileToggle = document.getElementById('mobileToggle');
      const sidebar = document.getElementById('sidebar');
      const sidebarOverlay = document.getElementById('sidebarOverlay');
      if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
          const isOpen = sidebar.classList.toggle('open');
          sidebarOverlay.classList.toggle('active');
          mobileToggle.setAttribute('aria-expanded', String(isOpen));
        });
      }
      if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
          sidebar.classList.remove('open');
          sidebarOverlay.classList.remove('active');
          if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
        });
      }

      // Apply permissions
      this.applyPermissions();

      // Init sync/share UI
      this.initSyncUI();

      // Show backup reminder if needed
      this.showBackupReminder();

      // Init user menu dropdown on logged-in pages
      this.initUserMenu();

      // Notify ready callbacks
      App._setReady();
    },

    applyPermissions() {
      const canEdit = App.Permissions.canEdit();
      const canManage = App.Permissions.canManageUsers();
      document.body.setAttribute('data-can-edit', canEdit);
      document.body.setAttribute('data-can-manage', canManage);

      // Disable form inputs for read-only users (skip login page)
      if (!canEdit && !document.body.classList.contains('login-page')) {
        document.querySelectorAll('form .form-input, form .form-select, form .form-textarea').forEach(el => {
          el.disabled = true;
        });
      }
    },

    showAlert(container, message, type = 'danger') {
      const alert = document.createElement('div');
      alert.className = `alert alert-${type}`;
      alert.innerHTML = message;
      container.prepend(alert);
      setTimeout(() => alert.remove(), 5000);
    },

    formatCurrency(amount) {
      if (amount === null || amount === undefined || amount === '') return '$0.00';
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
    },

    formatDate(dateStr) {
      if (!dateStr) return '-';
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    },

    escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    // Modal helpers
    openModal(modalId) {
      const el = document.getElementById(modalId);
      if (el) el.classList.add('active');
    },

    closeModal(modalId) {
      const el = document.getElementById(modalId);
      if (el) el.classList.remove('active');
    },

    // Passphrase modal
    renderPassphraseModal() {
      if (document.getElementById('passphraseModal')) return;
      const modal = document.createElement('div');
      modal.id = 'passphraseModal';
      modal.className = 'modal-overlay active';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = `
        <div class="modal" style="max-width:400px;">
          <div class="modal-header">
            <div class="modal-title">Enter Passphrase</div>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
              This estate is encrypted. Please enter your passphrase to unlock your data.
            </p>
            <form id="passphraseForm">
              <div class="form-group">
                <label class="form-label" for="passphraseInput">Passphrase</label>
                <input type="password" id="passphraseInput" class="form-input" placeholder="Enter your passphrase" required>
              </div>
              <div class="btn-group">
                <button type="submit" class="btn btn-primary">Unlock</button>
              </div>
            </form>
            <div id="passphraseError" style="margin-top:1rem;"></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    showPassphraseModal(onSubmit) {
      this.renderPassphraseModal();
      const form = document.getElementById('passphraseForm');
      const error = document.getElementById('passphraseError');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const passphrase = document.getElementById('passphraseInput').value;
        const valid = await App.Crypto.verifyPassphrase(passphrase);
        if (valid) {
          await App.Crypto.setPassphrase(passphrase);
          App.Crypto.savePassphraseToSession();
          this.closeModal('passphraseModal');
          if (onSubmit) onSubmit(passphrase);
        } else {
          error.innerHTML = '<div class="alert alert-danger">Invalid passphrase. Please try again.</div>';
        }
      };
    },

    // User menu dropdown
    initUserMenu() {
      if (document.body.classList.contains('login-page')) return;
      const userInfo = document.querySelector('.user-info');
      if (!userInfo) return;
      if (userInfo.querySelector('.user-menu-dropdown')) return;

      userInfo.style.position = 'relative';
      userInfo.style.cursor = 'pointer';
      userInfo.setAttribute('title', 'Click for user menu');
      userInfo.setAttribute('tabindex', '0');
      userInfo.setAttribute('role', 'button');
      userInfo.setAttribute('aria-haspopup', 'true');
      userInfo.setAttribute('aria-expanded', 'false');

      const dropdown = document.createElement('div');
      dropdown.className = 'user-menu-dropdown';
      dropdown.style.cssText = 'display:none; position:absolute; top:calc(100% + 0.5rem); right:0; background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius); box-shadow:0 4px 12px rgba(0,0,0,0.15); min-width:200px; z-index:1000; padding:0.5rem 0; font-size:0.9rem;';
      dropdown.innerHTML = `
        <div class="user-menu-header" style="padding:0.5rem 1rem; border-bottom:1px solid var(--border-color); color:var(--text-secondary); font-size:0.8rem;">
          <div id="userMenuName" style="font-weight:600; color:var(--text-primary);"></div>
          <div id="userMenuRole" style="font-size:0.75rem;"></div>
        </div>
        <button type="button" class="user-menu-item" id="userMenuChangePassword" style="display:block; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--text-primary); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0110 0v4"></path></svg>
          Change Password
        </button>
        <button type="button" class="user-menu-item" id="userMenuPromoteAdmin" style="display:none; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--text-primary); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
          Promote to Admin
        </button>
        <button type="button" class="user-menu-item" onclick="App.Auth.logout()" style="display:block; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--text-primary); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          Logout
        </button>
      `;
      userInfo.appendChild(dropdown);

      const currentUser = App.Auth.getCurrentUser();
      if (currentUser) {
        const nameEl = dropdown.querySelector('#userMenuName');
        const roleEl = dropdown.querySelector('#userMenuRole');
        if (nameEl) nameEl.textContent = currentUser.name;
        if (roleEl) roleEl.textContent = App.Permissions.getRoleLabel(currentUser.role);
      }

      const promoteBtn = dropdown.querySelector('#userMenuPromoteAdmin');
      if (promoteBtn && currentUser && currentUser.role !== 'Admin') {
        promoteBtn.style.display = 'block';
      }

      const toggleDropdown = (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display === 'block';
        dropdown.style.display = isOpen ? 'none' : 'block';
        userInfo.setAttribute('aria-expanded', String(!isOpen));
      };

      userInfo.addEventListener('click', toggleDropdown);
      userInfo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleDropdown(e);
        }
      });

      document.addEventListener('click', (e) => {
        if (!userInfo.contains(e.target)) {
          dropdown.style.display = 'none';
          userInfo.setAttribute('aria-expanded', 'false');
        }
      });

      dropdown.querySelector('#userMenuChangePassword').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.style.display = 'none';
        userInfo.setAttribute('aria-expanded', 'false');
        this.showChangePasswordModal();
      });

      if (promoteBtn) {
        promoteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          dropdown.style.display = 'none';
          userInfo.setAttribute('aria-expanded', 'false');
          if (!confirm('Promote your account to Admin? This will give you full access to user management and all settings.')) return;
          const result = await App.Auth.promoteSelfToAdmin();
          if (result.success) {
            alert(result.message + ' The page will refresh to apply changes.');
            window.location.reload();
          } else {
            alert(result.message);
          }
        });
      }
    },

    // Change Password Modal
    renderChangePasswordModal() {
      if (document.getElementById('changePasswordModal')) return;
      const modal = document.createElement('div');
      modal.id = 'changePasswordModal';
      modal.className = 'modal-overlay';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'changePasswordTitle');
      modal.innerHTML = `
        <div class="modal" style="max-width:400px;">
          <div class="modal-header">
            <div class="modal-title" id="changePasswordTitle">Change Password</div>
            <button type="button" class="modal-close" onclick="App.UI.closeModal('changePasswordModal')" aria-label="Close change password modal">&times;</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">Enter your current password and choose a new one.</p>
            <div class="form-group">
              <label class="form-label" for="changePasswordCurrent">Current Password</label>
              <input type="password" id="changePasswordCurrent" class="form-input" placeholder="Enter current password" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="changePasswordNew">New Password</label>
              <input type="password" id="changePasswordNew" class="form-input" placeholder="Choose a new password" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="changePasswordConfirm">Confirm New Password</label>
              <input type="password" id="changePasswordConfirm" class="form-input" placeholder="Confirm new password" required>
            </div>
            <div id="changePasswordMessage"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="App.UI.closeModal('changePasswordModal')">Cancel</button>
            <button type="button" class="btn btn-primary" id="changePasswordSubmitBtn">Change Password</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    showChangePasswordModal() {
      this.renderChangePasswordModal();
      document.getElementById('changePasswordCurrent').value = '';
      document.getElementById('changePasswordNew').value = '';
      document.getElementById('changePasswordConfirm').value = '';
      document.getElementById('changePasswordMessage').innerHTML = '';
      this.openModal('changePasswordModal');

      const submitBtn = document.getElementById('changePasswordSubmitBtn');
      submitBtn.onclick = async () => {
        const current = document.getElementById('changePasswordCurrent').value;
        const newPass = document.getElementById('changePasswordNew').value;
        const confirm = document.getElementById('changePasswordConfirm').value;
        const msg = document.getElementById('changePasswordMessage');

        if (!current || !newPass || !confirm) {
          msg.innerHTML = '<div class="alert alert-danger">All fields are required.</div>';
          return;
        }
        if (newPass !== confirm) {
          msg.innerHTML = '<div class="alert alert-danger">New passwords do not match.</div>';
          return;
        }
        if (newPass.length < 6) {
          msg.innerHTML = '<div class="alert alert-danger">New password must be at least 6 characters.</div>';
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Changing...';
        try {
          const result = await App.Auth.changeOwnPassword(current, newPass);
          if (result.success) {
            msg.innerHTML = '<div class="alert alert-success">' + App.UI.escapeHtml(result.message) + '</div>';
            setTimeout(() => {
              this.closeModal('changePasswordModal');
            }, 2000);
          } else {
            msg.innerHTML = '<div class="alert alert-danger">' + App.UI.escapeHtml(result.message) + '</div>';
          }
        } catch (err) {
          msg.innerHTML = '<div class="alert alert-danger">An error occurred. Please try again.</div>';
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Change Password';
        }
      };
    },

    // Tab helpers
    initTabs(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const tabs = container.querySelectorAll('.tab');
      let panels = container.querySelectorAll('.tab-panel');
      let panelScope = container;
      if (panels.length === 0) {
        panelScope = container.closest('.modal') || container.parentElement;
        panels = panelScope.querySelectorAll('.tab-panel');
      }
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.tab;
          tabs.forEach(t => t.classList.remove('active'));
          panels.forEach(p => p.classList.remove('active'));
          tab.classList.add('active');
          const panel = panelScope.querySelector(`[data-panel="${target}"]`);
          if (panel) panel.classList.add('active');
        });
      });
    },

    initSyncUI() {
      const headerRight = document.querySelector('.header-right');
      if (headerRight) {
        const existing = document.getElementById('syncBtn');
        if (!existing) {
          const syncBtn = document.createElement('button');
          syncBtn.id = 'syncBtn';
          syncBtn.className = 'btn-icon';
          syncBtn.title = 'Sync & Share';
          syncBtn.setAttribute('aria-label', 'Open sync and share settings');
          syncBtn.innerHTML = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
          syncBtn.addEventListener('click', () => this.showSyncModal());
          const darkModeBtn = document.getElementById('darkModeToggle');
          if (darkModeBtn) {
            headerRight.insertBefore(syncBtn, darkModeBtn);
          } else {
            headerRight.appendChild(syncBtn);
          }
        }
      }

      const loginCard = document.querySelector('.login-card');
      if (loginCard) {
        const existing = document.getElementById('loginImportBtn');
        if (!existing) {
          const importBtn = document.createElement('button');
          importBtn.id = 'loginImportBtn';
          importBtn.className = 'btn btn-secondary';
          importBtn.style = 'width:100%; margin-top:0.5rem;';
          importBtn.innerHTML = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Import Estate Backup`;
          importBtn.addEventListener('click', () => this.showSyncModal('import'));
          const toggle = loginCard.querySelector('.login-toggle');
          if (toggle) {
            toggle.parentNode.insertBefore(importBtn, toggle.nextSibling);
          }
        }
      }

      this.renderSyncModal();
      this.initSyncModal();
    },

    renderSyncModal() {
      if (document.getElementById('syncModal')) return;
      const modal = document.createElement('div');
      modal.id = 'syncModal';
      modal.className = 'modal-overlay';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'syncModalTitle');
      modal.innerHTML = `
        <div class="modal sync-modal">
          <div class="modal-header">
            <div class="modal-title" id="syncModalTitle">Sync & Share</div>
            <button type="button" class="modal-close" onclick="App.UI.closeModal('syncModal')" aria-label="Close sync modal">&times;</button>
          </div>
          <div class="modal-body">
            <div class="tabs sync-tabs" id="syncTabs">
              <button type="button" class="tab active" data-tab="export">Export</button>
              <button type="button" class="tab" data-tab="import">Import</button>
              <button type="button" class="tab" data-tab="gist">GitHub Sync</button>
              <button type="button" class="tab" data-tab="security">Security</button>
            </div>

            <div class="tab-panel active" data-panel="export">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Export all your estate data as a backup file that can be shared with other users.
              </p>
              <p style="margin-bottom:1rem; font-size:0.8rem; color:var(--danger-color);">
                <strong>Note:</strong> Full backup includes user login credentials (passwords are hashed).
              <div class="btn-group" style="margin-bottom:1rem;">
                <button type="button" class="btn btn-primary" id="syncExportFull">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  Export Full Backup (with users)
                </button>
                <button type="button" class="btn btn-secondary" id="syncExportEstate">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  Export Estate Only
                </button>
              </div>
              <div id="syncExportStatus" class="sync-status"></div>
            </div>

            <div class="tab-panel" data-panel="import">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Import an estate backup file. This will replace your current data. Preview before confirming.
              </p>
              <div class="file-drop-zone" id="fileDropZone" role="button" tabindex="0" aria-label="Drop zone for importing estate backup JSON file">
                <div class="file-drop-zone-icon">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </div>
                <div class="file-drop-zone-text">Drop a .json backup file here, or <span class="file-drop-zone-browse">browse</span></div>
                <input type="file" id="syncImportFile" accept=".json,application/json" style="display:none;">
              </div>
              <div id="syncImportPreview" class="sync-preview" style="display:none;"></div>
              <div id="syncImportStatus" class="sync-status"></div>
              <div class="form-group" style="margin-top:1rem;">
                <label class="form-label" style="display:flex; align-items:center; gap:0.5rem;">
                  <input type="checkbox" id="syncImportIncludeUsers">
                  <span>Include user accounts (logins) from backup</span>
                </label>
              </div>
              <div class="btn-group" style="margin-top:1rem;">
                <button type="button" class="btn btn-primary" id="syncImportConfirm" disabled>Confirm Import</button>
                <button type="button" class="btn btn-secondary" id="syncImportCancel">Cancel</button>
              </div>
            </div>

            <div class="tab-panel" data-panel="security">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Protect your estate data with a passphrase. Encrypted backups are unreadable without the passphrase.
              </p>
              <div id="securitySetPassphrase" style="display:none;">
                <div class="form-group">
                  <label class="form-label" for="newPassphrase">New Passphrase</label>
                  <input type="password" id="newPassphrase" class="form-input" placeholder="Choose a strong passphrase">
                </div>
                <div class="form-group">
                  <label class="form-label" for="confirmPassphrase">Confirm Passphrase</label>
                  <input type="password" id="confirmPassphrase" class="form-input" placeholder="Confirm passphrase">
                </div>
                <button type="button" class="btn btn-primary" id="setPassphraseBtn">Enable Encryption</button>
              </div>
              <div id="securityChangePassphrase" style="display:none;">
                <div class="form-group">
                  <label class="form-label" for="currentPassphrase">Current Passphrase</label>
                  <input type="password" id="currentPassphrase" class="form-input" placeholder="Enter current passphrase">
                </div>
                <div class="form-group">
                  <label class="form-label" for="changeNewPassphrase">New Passphrase</label>
                  <input type="password" id="changeNewPassphrase" class="form-input" placeholder="Choose a new passphrase">
                </div>
                <div class="form-group">
                  <label class="form-label" for="changeConfirmPassphrase">Confirm New Passphrase</label>
                  <input type="password" id="changeConfirmPassphrase" class="form-input" placeholder="Confirm new passphrase">
                </div>
                <div class="btn-group">
                  <button type="button" class="btn btn-primary" id="changePassphraseBtn">Change Passphrase</button>
                  <button type="button" class="btn btn-danger" id="disableEncryptionBtn">Disable Encryption</button>
                </div>
              </div>
              <div id="securityStatus" class="sync-status"></div>
            </div>

            <div class="tab-panel" data-panel="gist">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Sync your estate data to a private GitHub Gist. Share the Gist ID with other users to collaborate.
              </p>
              <div class="form-group">
                <label class="form-label" for="gistToken">GitHub Personal Access Token</label>
                <input type="password" id="gistToken" class="form-input" placeholder="ghp_xxxxxxxxxxxx">
                <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">
                  <a href="https://github.com/settings/tokens/new?scopes=gist&description=EstatePro%20Sync" target="_blank" rel="noopener">Create a token with "gist" scope &rarr;</a>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label" for="gistId">Gist ID</label>
                <input type="text" id="gistId" class="form-input" placeholder="Enter existing Gist ID (use Create New Gist for new ones)">
                <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">
                  The Gist ID is the string from the Gist URL. Leave blank to create a new one.
                </div>
              </div>
              <div class="btn-group" style="margin-bottom:1rem;">
                <button type="button" class="btn btn-primary" id="gistSave">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  Save to Gist
                </button>
                <button type="button" class="btn btn-secondary" id="gistLoad">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  Load from Gist
                </button>
                <button type="button" class="btn btn-secondary" id="gistNew">Create New Gist</button>
              </div>
              <div id="gistStatus" class="sync-status"></div>
              <div id="gistLastSync" style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.5rem;"></div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      this.initTabs('syncTabs');
    },

    initSyncModal() {
      this.initExportHandlers();
      this.initImportHandlers();
      this.initGistHandlers();
      this.initSecurityHandlers();
    },

    initSecurityHandlers() {
      const setPanel = document.getElementById('securitySetPassphrase');
      const changePanel = document.getElementById('securityChangePassphrase');
      const setBtn = document.getElementById('setPassphraseBtn');
      const changeBtn = document.getElementById('changePassphraseBtn');
      const disableBtn = document.getElementById('disableEncryptionBtn');
      const status = document.getElementById('securityStatus');

      const updateSecurityUI = () => {
        const encrypted = App.Crypto.isEncryptionEnabled();
        if (setPanel) setPanel.style.display = encrypted ? 'none' : 'block';
        if (changePanel) changePanel.style.display = encrypted ? 'block' : 'none';
        if (status) status.innerHTML = encrypted ? '<div class="alert alert-success">Encryption is enabled. All backups and localStorage are encrypted.</div>' : '<div class="alert alert-info">Encryption is not enabled. Your data is stored in plaintext.</div>';
      };

      // Update UI when security tab is shown
      const tabs = document.querySelectorAll('#syncTabs .tab');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          if (tab.dataset.tab === 'security') {
            updateSecurityUI();
          }
        });
      });

      if (setBtn) {
        setBtn.addEventListener('click', async () => {
          const newPass = document.getElementById('newPassphrase').value;
          const confirmPass = document.getElementById('confirmPassphrase').value;
          if (!newPass || newPass.length < 6) {
            this.showSyncStatus('securityStatus', 'Passphrase must be at least 6 characters.', 'danger');
            return;
          }
          if (newPass !== confirmPass) {
            this.showSyncStatus('securityStatus', 'Passphrases do not match.', 'danger');
            return;
          }
          this.showSyncStatus('securityStatus', 'Encrypting data...', 'info');
          try {
            const result = await App.Crypto.setupEncryption(newPass);
            this.showSyncStatus('securityStatus', result.message, 'success');
            updateSecurityUI();
            document.getElementById('newPassphrase').value = '';
            document.getElementById('confirmPassphrase').value = '';
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Encryption failed: ' + err.message, 'danger');
          }
        });
      }

      if (changeBtn) {
        changeBtn.addEventListener('click', async () => {
          const currentPass = document.getElementById('currentPassphrase').value;
          const newPass = document.getElementById('changeNewPassphrase').value;
          const confirmPass = document.getElementById('changeConfirmPassphrase').value;
          if (!newPass || newPass.length < 6) {
            this.showSyncStatus('securityStatus', 'New passphrase must be at least 6 characters.', 'danger');
            return;
          }
          if (newPass !== confirmPass) {
            this.showSyncStatus('securityStatus', 'New passphrases do not match.', 'danger');
            return;
          }
          this.showSyncStatus('securityStatus', 'Changing passphrase...', 'info');
          try {
            const result = await App.Crypto.changePassphrase(currentPass, newPass);
            this.showSyncStatus('securityStatus', result.message, result.success ? 'success' : 'danger');
            if (result.success) {
              document.getElementById('currentPassphrase').value = '';
              document.getElementById('changeNewPassphrase').value = '';
              document.getElementById('changeConfirmPassphrase').value = '';
            }
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Change failed: ' + err.message, 'danger');
          }
        });
      }

      if (disableBtn) {
        disableBtn.addEventListener('click', async () => {
          const currentPass = document.getElementById('currentPassphrase').value;
          if (!currentPass) {
            this.showSyncStatus('securityStatus', 'Please enter your current passphrase.', 'danger');
            return;
          }
          if (!confirm('Are you sure you want to disable encryption? Your data will be stored in plaintext.')) {
            return;
          }
          this.showSyncStatus('securityStatus', 'Decrypting data...', 'info');
          try {
            const result = await App.Crypto.disableEncryption(currentPass);
            this.showSyncStatus('securityStatus', result.message, result.success ? 'success' : 'danger');
            if (result.success) {
              updateSecurityUI();
              document.getElementById('currentPassphrase').value = '';
            }
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Disable failed: ' + err.message, 'danger');
          }
        });
      }

      // Initialize UI state
      updateSecurityUI();
    },

    initExportHandlers() {
      const exportFull = document.getElementById('syncExportFull');
      if (exportFull) {
        exportFull.addEventListener('click', () => {
          App.Sync.exportAll();
          this.showSyncStatus('syncExportStatus', 'Full backup exported!', 'success');
          this.hideBackupReminder();
        });
      }
      const exportEstate = document.getElementById('syncExportEstate');
      if (exportEstate) {
        exportEstate.addEventListener('click', () => {
          App.Sync.exportEstateOnly();
          this.showSyncStatus('syncExportStatus', 'Estate data exported!', 'success');
          this.hideBackupReminder();
        });
      }
    },

    initImportHandlers() {
      const fileDropZone = document.getElementById('fileDropZone');
      const fileInput = document.getElementById('syncImportFile');
      const importPreview = document.getElementById('syncImportPreview');
      const importConfirm = document.getElementById('syncImportConfirm');
      const importCancel = document.getElementById('syncImportCancel');
      const importStatus = document.getElementById('syncImportStatus');

      let pendingImport = null;

      const handleImportFile = async (file) => {
        this.showSyncStatus('syncImportStatus', 'Reading file...', 'info');
        const result = await App.Sync.importFromFile(file);
        if (result.success) {
          pendingImport = result.validation;
          if (importPreview) importPreview.style.display = 'block';
          const v = result.validation;
          const estate = v.data.estate;
          const netValue = (estate.assets || []).reduce((s, a) => s + (parseFloat(a.value) || 0), 0) - (estate.debts || []).filter(d => d.status !== 'Paid').reduce((s, d) => s + (parseFloat(d.balance) || 0), 0);
          importPreview.innerHTML = `
            <div class="sync-preview-header">Preview of imported data:</div>
            <div class="sync-preview-grid">
              <div><strong>Version:</strong> ${v.data.version || 'N/A'}</div>
              <div><strong>Exported:</strong> ${v.data.exportedAt ? App.UI.formatDate(v.data.exportedAt.split('T')[0]) : 'N/A'}</div>
              <div><strong>Assets:</strong> ${(estate.assets || []).length}</div>
              <div><strong>Debts:</strong> ${(estate.debts || []).length}</div>
              <div><strong>Tasks:</strong> ${(estate.tasks || []).length}</div>
              <div><strong>Heirs:</strong> ${(estate.heirs || []).length}</div>
              <div><strong>Users:</strong> ${v.hasUsers ? (v.data.users || []).length : 'None'}</div>
              <div><strong>Net Value:</strong> ${App.UI.formatCurrency(netValue)}</div>
            </div>
          `;
          if (importConfirm) importConfirm.disabled = false;
          this.showSyncStatus('syncImportStatus', 'File validated. Review the preview and click Confirm Import.', 'success');
        } else {
          pendingImport = null;
          if (importPreview) importPreview.style.display = 'none';
          if (importConfirm) importConfirm.disabled = true;
          this.showSyncStatus('syncImportStatus', result.message, 'danger');
        }
      };

      if (fileDropZone && fileInput) {
        fileDropZone.addEventListener('click', () => fileInput.click());
        fileDropZone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
          }
        });
        fileDropZone.addEventListener('dragover', (e) => {
          e.preventDefault();
          fileDropZone.classList.add('drag-over');
        });
        fileDropZone.addEventListener('dragleave', () => {
          fileDropZone.classList.remove('drag-over');
        });
        fileDropZone.addEventListener('drop', (e) => {
          e.preventDefault();
          fileDropZone.classList.remove('drag-over');
          const file = e.dataTransfer.files[0];
          if (file) handleImportFile(file);
        });
        fileInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) handleImportFile(file);
        });
      }

      if (importConfirm) {
        importConfirm.addEventListener('click', () => {
          if (!pendingImport) return;
          const includeUsers = document.getElementById('syncImportIncludeUsers')?.checked;
          const result = App.Sync.applyImport(pendingImport, { includeUsers });
          this.showSyncStatus('syncImportStatus', result.message, result.success ? 'success' : 'danger');
          if (result.success) {
            importConfirm.disabled = true;
            pendingImport = null;
            setTimeout(() => {
              window.location.reload();
            }, 2000);
          }
        });
      }

      if (importCancel) {
        importCancel.addEventListener('click', () => {
          pendingImport = null;
          if (importPreview) importPreview.style.display = 'none';
          if (importConfirm) importConfirm.disabled = true;
          if (fileInput) fileInput.value = '';
          if (importStatus) importStatus.innerHTML = '';
        });
      }
    },

    initGistHandlers() {
      const gistToken = document.getElementById('gistToken');
      const gistId = document.getElementById('gistId');
      const gistSave = document.getElementById('gistSave');
      const gistLoad = document.getElementById('gistLoad');
      const gistNew = document.getElementById('gistNew');
      const gistStatus = document.getElementById('gistStatus');
      const gistLastSync = document.getElementById('gistLastSync');

      const config = App.Gist.getConfig();
      if (gistToken && config.token) gistToken.value = config.token;
      if (gistId && config.gistId) gistId.value = config.gistId;
      if (gistLastSync) {
        const lastSync = App.Gist.getLastSyncTime();
        gistLastSync.textContent = lastSync ? `Last synced: ${App.UI.formatDate(lastSync.split('T')[0])} at ${lastSync.split('T')[1].substring(0, 5)}` : 'Never synced';
      }

      if (gistSave) {
        gistSave.addEventListener('click', async () => {
          const token = gistToken.value.trim();
          const id = gistId.value.trim();
          if (!token) {
            this.showSyncStatus('gistStatus', 'Please enter a GitHub token.', 'danger');
            return;
          }
          if (!id) {
            this.showSyncStatus('gistStatus', 'Please enter a Gist ID to save to, or use Create New Gist.', 'danger');
            return;
          }
          this.showSyncStatus('gistStatus', 'Saving to Gist...', 'info');
          try {
            await App.Gist.saveToGist(token, id, App.Sync.getExportData());
            this.showSyncStatus('gistStatus', 'Saved to Gist successfully!', 'success');
            App.Gist.saveConfig({ token, gistId: id });
            App.Gist.saveLastSyncTime();
            this.hideBackupReminder();
            if (gistLastSync) gistLastSync.textContent = `Last synced: ${App.UI.formatDate(new Date().toISOString().split('T')[0])} at ${new Date().toTimeString().substring(0, 5)}`;
          } catch (err) {
            this.showSyncStatus('gistStatus', err.message, 'danger');
          }
        });
      }

      if (gistLoad) {
        gistLoad.addEventListener('click', async () => {
          const token = gistToken.value.trim();
          const id = gistId.value.trim();
          if (!token || !id) {
            this.showSyncStatus('gistStatus', 'Please enter both token and Gist ID.', 'danger');
            return;
          }
          this.showSyncStatus('gistStatus', 'Loading from Gist...', 'info');
          try {
            const result = await App.Gist.loadFromGist(token, id);
            const validation = App.Sync.validateImportData(result.data);
            if (!validation.valid) {
              this.showSyncStatus('gistStatus', validation.error, 'danger');
              return;
            }
            App.Gist.saveConfig({ token, gistId: id });
            App.Gist.saveLastSyncTime();
            const importResult = App.Sync.applyImport(validation, { includeUsers: true });
            this.showSyncStatus('gistStatus', importResult.message, importResult.success ? 'success' : 'danger');
            if (importResult.success) {
              setTimeout(() => window.location.reload(), 2000);
            }
          } catch (err) {
            this.showSyncStatus('gistStatus', err.message, 'danger');
          }
        });
      }

      if (gistNew) {
        gistNew.addEventListener('click', async () => {
          const token = gistToken.value.trim();
          if (!token) {
            this.showSyncStatus('gistStatus', 'Please enter a GitHub token.', 'danger');
            return;
          }
          this.showSyncStatus('gistStatus', 'Creating new Gist...', 'info');
          try {
            const gid = await App.Gist.createGist(token, App.Sync.getExportData());
            if (gistId) gistId.value = gid;
            App.Gist.saveConfig({ token, gistId: gid });
            App.Gist.saveLastSyncTime();
            this.hideBackupReminder();
            this.showSyncStatus('gistStatus', `New Gist created! ID: ${gid}`, 'success');
            if (gistLastSync) gistLastSync.textContent = `Last synced: ${App.UI.formatDate(new Date().toISOString().split('T')[0])} at ${new Date().toTimeString().substring(0, 5)}`;
          } catch (err) {
            this.showSyncStatus('gistStatus', err.message, 'danger');
          }
        });
      }
    },

    showSyncModal(activeTab) {
      let modal = document.getElementById('syncModal');
      if (!modal) {
        this.renderSyncModal();
        this.initSyncModal();
        modal = document.getElementById('syncModal');
      }
      // Clear stale status messages and preview
      modal.querySelectorAll('.sync-status').forEach(el => el.innerHTML = '');
      const preview = document.getElementById('syncImportPreview');
      const confirmBtn = document.getElementById('syncImportConfirm');
      if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
      if (confirmBtn) confirmBtn.disabled = true;
      this.openModal('syncModal');
      const tabs = document.querySelectorAll('#syncTabs .tab');
      const panels = document.querySelectorAll('#syncModal .tab-panel');
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      const targetTab = document.querySelector(`#syncTabs .tab[data-tab="${activeTab || 'export'}"]`);
      const targetPanel = document.querySelector(`#syncModal .tab-panel[data-panel="${activeTab || 'export'}"]`);
      if (targetTab) targetTab.classList.add('active');
      if (targetPanel) targetPanel.classList.add('active');
    },

    showBackupReminder() {
      if (!App.BackupReminder.shouldShowReminder()) return;
      const content = document.querySelector('.content');
      if (!content) return;
      const existing = document.getElementById('backupReminderBanner');
      if (existing) return;

      const days = App.BackupReminder.getDaysSinceLastBackup();
      const timeText = days === Infinity
        ? 'You have never backed up your estate data'
        : `You haven't backed up your estate data in ${days} day${days !== 1 ? 's' : ''}`;

      const banner = document.createElement('div');
      banner.id = 'backupReminderBanner';
      banner.className = 'backup-reminder';
      banner.setAttribute('role', 'alert');
      banner.setAttribute('aria-live', 'polite');
      banner.innerHTML = `
        <svg class="backup-reminder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        <div class="backup-reminder-text">
          <strong>${timeText}.</strong> Back up now to protect against data loss.
        </div>
        <div class="backup-reminder-actions">
          <button class="btn btn-sm btn-primary backup-reminder-btn" data-action="backup">Back Up Now</button>
          <button class="btn btn-sm btn-secondary backup-reminder-btn" data-action="dismiss-day">Dismiss 1 Day</button>
          <button class="btn btn-sm btn-secondary backup-reminder-btn" data-action="dismiss-week">Dismiss 1 Week</button>
        </div>
      `;
      content.insertBefore(banner, content.firstChild);

      banner.querySelectorAll('.backup-reminder-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const action = e.target.dataset.action;
          if (action === 'backup') {
            this.showSyncModal('export');
          } else if (action === 'dismiss-day') {
            App.BackupReminder.setDismissedUntil(24);
            banner.remove();
          } else if (action === 'dismiss-week') {
            App.BackupReminder.setDismissedUntil(24 * 7);
            banner.remove();
          }
        });
      });
    },

    hideBackupReminder() {
      const banner = document.getElementById('backupReminderBanner');
      if (banner) banner.remove();
    },

    showSyncStatus(id, message, type) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<div class="alert alert-${type}">${App.UI.escapeHtml(message)}</div>`;
    }
  }
};

/* ============================================
   App init & ready callbacks
   ============================================ */
App._readyCallbacks = [];
App._ready = false;

App.onReady = function(callback) {
  if (this._ready) {
    callback();
  } else {
    this._readyCallbacks.push(callback);
  }
};

App._setReady = function() {
  this._ready = true;
  this._readyCallbacks.forEach(cb => cb());
  this._readyCallbacks = [];
};

App.init = async function() {
  // Try to restore passphrase from sessionStorage for same-session navigation
  if (this.Crypto.isEncryptionEnabled() && !this.Crypto.hasPassphrase()) {
    this.Crypto.loadPassphraseFromSession();
  }
  await this.Crypto.init();
  this.UI.init();
};

// Track pending writes to warn before unload
App._pendingWrites = 0;
const _originalWriteStorage = App.Crypto.writeStorage.bind(App.Crypto);
App.Crypto.writeStorage = async function(key, value) {
  App._pendingWrites++;
  try {
    return await _originalWriteStorage(key, value);
  } finally {
    App._pendingWrites--;
  }
};

window.addEventListener('beforeunload', (e) => {
  if (App._pendingWrites > 0) {
    e.preventDefault();
    e.returnValue = 'Data is still being saved. Are you sure you want to leave?';
  }
});

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});


