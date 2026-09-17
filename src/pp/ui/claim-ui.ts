export function claimUiHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ativação de Conta — PUB Prototype Sovereign Auth</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  color-scheme: dark;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #09090b;
  color: #fafafa;
  --bg-base: #09090b;
  --bg-elevated: #111114;
  --bg-elevated-2: #18181b;
  --border: #27272a;
  --border-strong: #3f3f46;
  --text-primary: #fafafa;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;
  --accent: #fafafa;
  --accent-fg: #09090b;
  --danger: #ef4444;
  --danger-bg: rgba(239, 68, 68, 0.1);
  --danger-border: rgba(239, 68, 68, 0.25);
  --success: #22c55e;
  --success-bg: rgba(34, 197, 94, 0.1);
  --success-border: rgba(34, 197, 94, 0.25);
}
* { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: radial-gradient(circle at 50% 20%, #18181b 0%, #09090b 100%);
}
.claim-card {
  width: 100%;
  max-width: 440px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 32px 28px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.4);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.brand-mark {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #ffffff 0%, #a1a1aa 100%);
  display: grid;
  place-items: center;
  color: #09090b;
  font-weight: 800;
  font-size: 14px;
}
.brand-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}
p.desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin: 0 0 24px 0;
}
.form-group {
  margin-bottom: 18px;
}
label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
input {
  width: 100%;
  height: 42px;
  background: var(--bg-elevated-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 14px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}
input:focus {
  border-color: var(--accent);
}
.btn-submit {
  width: 100%;
  height: 44px;
  background: var(--accent);
  color: var(--accent-fg);
  border: 0;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 24px;
  transition: opacity 0.15s;
}
.btn-submit:hover:not(:disabled) {
  opacity: 0.92;
}
.btn-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.banner {
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  margin-bottom: 18px;
  display: none;
}
.banner.danger {
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: #fca5a5;
  display: block;
}
.banner.success {
  background: var(--success-bg);
  border: 1px solid var(--success-border);
  color: #86efac;
  display: block;
}
.success-actions {
  margin-top: 20px;
}
.btn-action {
  display: block;
  width: 100%;
  text-align: center;
  padding: 12px;
  background: var(--accent);
  color: var(--accent-fg);
  border-radius: 8px;
  font-weight: 600;
  text-decoration: none;
  font-size: 14px;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(0,0,0,0.2);
  border-top-color: #09090b;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
</head>
<body>
<div class="claim-card">
  <div class="brand">
    <div class="brand-mark">PP</div>
    <div class="brand-title">PUB Prototype · Sovereign Auth</div>
  </div>

  <div id="missingTokenBanner" class="banner danger" style="display:none;">
    Token de ativação ausente ou inválido na URL. Verifique o link recebido por e-mail.
  </div>

  <div id="claimFormContainer">
    <h1>Ativar Conta e Definir Senha</h1>
    <p class="desc">Defina sua senha soberana para concluir a migração e ativar o acesso independente ao PUB Prototype.</p>

    <div id="alertBanner" class="banner"></div>

    <form id="claimForm">
      <div class="form-group">
        <label for="password">Nova Senha</label>
        <input type="password" id="password" required minlength="8" maxlength="128" placeholder="No mínimo 8 caracteres" autocomplete="new-password"/>
      </div>
      <div class="form-group">
        <label for="confirmPassword">Confirmar Nova Senha</label>
        <input type="password" id="confirmPassword" required minlength="8" maxlength="128" placeholder="Repita a nova senha" autocomplete="new-password"/>
      </div>
      <button type="submit" id="submitBtn" class="btn-submit">
        <span>Concluir Ativação</span>
      </button>
    </form>
  </div>

  <div id="successContainer" style="display:none;">
    <h1>Conta Ativada com Sucesso</h1>
    <p class="desc">Sua senha foi definida e sua credencial soberana foi estabelecida. A identidade e workspaces foram integralmente preservados.</p>
    <div class="banner success" style="display:block;">
      Ativação concluída! Você já pode acessar a plataforma soberana.
    </div>
    <div class="success-actions">
      <a href="/prototype" class="btn-action">Acessar PUB Prototype</a>
    </div>
  </div>
</div>

<script>
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  const missingTokenBanner = document.getElementById('missingTokenBanner');
  const claimFormContainer = document.getElementById('claimFormContainer');
  const alertBanner = document.getElementById('alertBanner');
  const claimForm = document.getElementById('claimForm');
  const submitBtn = document.getElementById('submitBtn');
  const successContainer = document.getElementById('successContainer');

  if (!token || !token.trim()) {
    missingTokenBanner.style.display = 'block';
    claimFormContainer.style.display = 'none';
    return;
  }

  function showAlert(message, type) {
    alertBanner.textContent = message;
    alertBanner.className = 'banner ' + type;
    alertBanner.style.display = 'block';
  }

  function hideAlert() {
    alertBanner.style.display = 'none';
  }

  claimForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    hideAlert();

    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (password !== confirmPassword) {
      showAlert('As senhas digitadas não coincidem.', 'danger');
      return;
    }

    if (password.length < 8 || password.length > 128) {
      showAlert('A senha deve ter entre 8 e 128 caracteres.', 'danger');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner"></div><span>Ativando...</span>';

    try {
      const response = await fetch('/prototype/auth/claim/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          token: token.trim(),
          password: password
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMsg = data.error === 'INVALID_OR_EXPIRED_TOKEN'
          ? 'Link de ativação inválido ou expirado. Solicite uma nova ativação.'
          : (data.message || 'Falha ao ativar conta. Tente novamente.');
        showAlert(errorMsg, 'danger');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Concluir Ativação</span>';
        return;
      }

      claimFormContainer.style.display = 'none';
      successContainer.style.display = 'block';
    } catch (err) {
      showAlert('Erro de conexão com o servidor. Tente novamente.', 'danger');
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Concluir Ativação</span>';
    }
  });
})();
</script>
</body>
</html>`;
}
