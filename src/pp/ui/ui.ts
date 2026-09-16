export function prototypeUiHtml(): string {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PUB Prototype 2.0 — AI Development Workspace</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme:dark;
  font-family:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;
  background:#0a0a0b;
  color:#fafafa;
  --bg-base:#0a0a0b;
  --bg-elevated:#111114;
  --bg-elevated-2:#18181b;
  --bg-elevated-3:#1f1f23;
  --border:#27272a;
  --border-strong:#3f3f46;
  --text-primary:#fafafa;
  --text-secondary:#a1a1aa;
  --text-tertiary:#71717a;
  --text-quaternary:#52525b;
  --accent:#fafafa;
  --accent-fg:#0a0a0b;
  --success:#22c55e;
  --success-bg:rgba(34,197,94,.1);
  --success-border:rgba(34,197,94,.3);
  --warning:#f59e0b;
  --warning-bg:rgba(245,158,11,.1);
  --warning-border:rgba(245,158,11,.3);
  --danger:#ef4444;
  --danger-bg:rgba(239,68,68,.1);
  --danger-border:rgba(239,68,68,.3);
  --info:#3b82f6;
  --info-bg:rgba(59,130,246,.1);
  --info-border:rgba(59,130,246,.3);
  --radius-sm:6px;
  --radius:8px;
  --radius-md:10px;
  --radius-lg:14px;
  --radius-xl:20px;
  --shadow-sm:0 1px 2px rgba(0,0,0,.4);
  --shadow:0 4px 12px rgba(0,0,0,.3);
  --shadow-lg:0 12px 32px rgba(0,0,0,.4);
  --transition:150ms cubic-bezier(.4,0,.2,1);
}
*{box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
html,body{margin:0;height:100vh;overflow:hidden;background:var(--bg-base)}
body{font-size:14px;line-height:1.5}
button{font-family:inherit;font-size:inherit;cursor:pointer;border:0;background:none;color:inherit;padding:0}
input,textarea{font-family:inherit;font-size:inherit;color:inherit}
::-webkit-scrollbar{width:7px;height:7px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}

.app{display:flex;height:100vh;overflow:hidden;background:var(--bg-base);width:100vw}

/* Sidebar */
.sidebar{
  width:260px;
  min-width:260px;
  max-width:260px;
  transition:width var(--transition),min-width var(--transition),max-width var(--transition);
  display:flex;
  flex-direction:column;
  border-right:1px solid var(--border);
  background:var(--bg-elevated);
  overflow:hidden;
  position:relative;
  z-index:20;
}
.sidebar.collapsed{
  width:56px;
  min-width:56px;
  max-width:56px;
}
.sidebar-header{
  height:52px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:0 14px;
  border-bottom:1px solid var(--border);
  flex-shrink:0;
}
.sidebar.collapsed .sidebar-header{
  padding:0;
  justify-content:center;
}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px;letter-spacing:-.01em;cursor:pointer}
.brand-mark{
  width:28px;
  height:28px;
  border-radius:7px;
  background:linear-gradient(135deg,#fafafa 0%,#a1a1aa 100%);
  display:grid;
  place-items:center;
  color:#0a0a0b;
  font-size:13px;
  font-weight:800;
  box-shadow:var(--shadow-sm);
  flex-shrink:0;
}
.sidebar.collapsed .brand span{display:none}
.icon-btn{width:28px;height:28px;display:grid;place-items:center;border-radius:var(--radius);color:var(--text-secondary);transition:var(--transition);flex-shrink:0}
.icon-btn:hover{background:var(--bg-elevated-2);color:var(--text-primary)}
.icon-btn svg{width:16px;height:16px}
.sidebar.collapsed #collapseSidebar{display:none}

.projects-section{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:12px 10px}
.sidebar.collapsed .projects-section{padding:8px 4px}
.projects-header{display:flex;align-items:center;justify-content:space-between;padding:0 4px 8px;flex-shrink:0}
.sidebar.collapsed .projects-header{justify-content:center;padding:0 0 8px}
.projects-header-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-tertiary)}
.sidebar.collapsed .projects-header-label{display:none}
.btn-new{
  display:flex;
  align-items:center;
  gap:5px;
  padding:5px 9px;
  border-radius:var(--radius);
  background:var(--bg-elevated-2);
  border:1px solid var(--border);
  color:var(--text-secondary);
  font-size:11px;
  font-weight:600;
  transition:var(--transition);
}
.btn-new:hover{background:var(--bg-elevated-3);color:var(--text-primary);border-color:var(--border-strong)}
.btn-new svg{width:13px;height:13px}
.sidebar.collapsed .btn-new{padding:8px;border-radius:50%}
.sidebar.collapsed .btn-new span{display:none}

.projects-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px;padding:0 2px}
.projects-list:empty::before{content:'Nenhum projeto ainda';display:block;text-align:center;color:var(--text-quaternary);font-size:12px;padding:20px 0}
.project-item{
  display:flex;
  align-items:center;
  gap:10px;
  padding:7px 8px;
  border-radius:var(--radius);
  cursor:pointer;
  border:1px solid transparent;
  transition:var(--transition);
  position:relative;
  group:true;
}
.sidebar.collapsed .project-item{justify-content:center;padding:10px 0}
.project-item:hover{background:var(--bg-elevated-2)}
.project-item.active{background:var(--bg-elevated-2);border-color:var(--border-strong)}
.project-status{width:8px;height:8px;border-radius:50%;flex-shrink:0;position:relative}
.project-status.ready{background:var(--success);box-shadow:0 0 0 3px var(--success-bg)}
.project-status.building{background:var(--info);box-shadow:0 0 0 3px var(--info-bg);animation:pulse 1.5s ease-in-out infinite}
.project-status.failed{background:var(--danger);box-shadow:0 0 0 3px var(--danger-bg)}
.project-status.creating{background:var(--warning);box-shadow:0 0 0 3px var(--warning-bg);animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.project-info{flex:1;min-width:0}
.sidebar.collapsed .project-info{display:none}
.project-name{font-size:13px;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.project-meta{font-size:11px;color:var(--text-tertiary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px}
.project-meta .dot{width:2px;height:2px;background:var(--text-quaternary);border-radius:50%}

.project-del-btn{
  opacity:0;
  width:22px;
  height:22px;
  display:grid;
  place-items:center;
  border-radius:4px;
  color:var(--text-tertiary);
  transition:var(--transition);
  flex-shrink:0;
}
.project-item:hover .project-del-btn{opacity:1}
.project-del-btn:hover{background:var(--danger-bg);color:var(--danger)}
.project-del-btn svg{width:13px;height:13px}
.sidebar.collapsed .project-del-btn{display:none}

.sidebar-footer{padding:10px;border-top:1px solid var(--border);flex-shrink:0}
.sidebar.collapsed .sidebar-footer{display:none}
.session-info{font-size:10px;color:var(--text-tertiary);font-family:'JetBrains Mono',monospace;word-break:break-all;line-height:1.3;padding:6px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm)}

/* Main Content Area */
.main-area{
  flex:1;
  display:flex;
  flex-direction:column;
  height:100vh;
  overflow:hidden;
  min-width:0;
}

/* Topbar */
.topbar{
  height:52px;
  min-height:52px;
  border-bottom:1px solid var(--border);
  background:var(--bg-elevated);
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:0 16px;
  gap:12px;
  z-index:10;
  flex-shrink:0;
}
.topbar-left{display:flex;align-items:center;gap:10px;min-width:0}
.topbar-center{display:flex;align-items:center;gap:6px}
.topbar-right{display:flex;align-items:center;gap:10px}

.workspace-badge{
  display:flex;
  align-items:center;
  gap:6px;
  padding:4px 8px;
  background:var(--bg-elevated-2);
  border:1px solid var(--border);
  border-radius:var(--radius-sm);
  font-size:11px;
  font-weight:600;
  color:var(--text-secondary);
}
.project-title-editor{
  display:flex;
  align-items:center;
  gap:6px;
  font-weight:600;
  font-size:13px;
  color:var(--text-primary);
  max-width:220px;
}
.project-title-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn-edit-title{width:20px;height:20px;display:grid;place-items:center;border-radius:4px;color:var(--text-tertiary);transition:var(--transition)}
.btn-edit-title:hover{color:var(--text-primary);background:var(--bg-elevated-2)}
.btn-edit-title svg{width:12px;height:12px}

.branch-badge{
  display:flex;
  align-items:center;
  gap:5px;
  padding:3px 8px;
  background:var(--bg-base);
  border:1px solid var(--border);
  border-radius:var(--radius-sm);
  font-size:11px;
  color:var(--text-tertiary);
  font-family:'JetBrains Mono',monospace;
  max-width:180px;
}
.branch-badge span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.branch-badge svg{width:12px;height:12px;flex-shrink:0}

.nav-tabs{
  display:flex;
  background:var(--bg-base);
  padding:3px;
  border-radius:var(--radius);
  border:1px solid var(--border);
  gap:2px;
}
.nav-tab{
  display:flex;
  align-items:center;
  gap:6px;
  padding:4px 10px;
  border-radius:6px;
  font-size:12px;
  font-weight:500;
  color:var(--text-secondary);
  transition:var(--transition);
}
.nav-tab:hover{color:var(--text-primary)}
.nav-tab.active{
  background:var(--bg-elevated-2);
  color:var(--text-primary);
  font-weight:600;
  box-shadow:var(--shadow-sm);
}
.nav-tab svg{width:14px;height:14px}

.topbar-btn{
  display:flex;
  align-items:center;
  gap:6px;
  padding:5px 10px;
  border-radius:var(--radius-sm);
  font-size:12px;
  font-weight:500;
  color:var(--text-secondary);
  border:1px solid var(--border);
  background:var(--bg-elevated-2);
  transition:var(--transition);
  text-decoration:none;
}
.topbar-btn:hover{color:var(--text-primary);border-color:var(--border-strong);background:var(--bg-elevated-3)}
.topbar-btn svg{width:13px;height:13px}
.topbar-btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
.topbar-btn.primary:hover{background:#e4e4e7}

.user-pill{
  display:flex;
  align-items:center;
  gap:6px;
  padding:3px 8px;
  border-radius:var(--radius-sm);
  background:var(--bg-elevated-2);
  border:1px solid var(--border);
  font-size:12px;
}
.user-avatar-sm{
  width:20px;
  height:20px;
  border-radius:50%;
  background:var(--accent);
  color:var(--accent-fg);
  font-size:10px;
  font-weight:700;
  display:grid;
  place-items:center;
}
.role-badge{
  font-size:9px;
  padding:1px 5px;
  border-radius:4px;
  background:var(--success-bg);
  border:1px solid var(--success-border);
  color:var(--success);
  font-weight:700;
  letter-spacing:.04em;
}

/* Panes */
.workspace-panes{
  flex:1;
  display:grid;
  grid-template-columns:1fr 6px 1.2fr;
  overflow:hidden;
  min-height:0;
}
.workspace-panes.fullscreen-preview{
  grid-template-columns:0 0 1fr;
}
.workspace-panes.fullscreen-preview .left-panes,
.workspace-panes.fullscreen-preview .splitter{
  display:none;
}

.left-panes{
  display:flex;
  flex-direction:column;
  height:100%;
  overflow:hidden;
  min-width:0;
  background:var(--bg-base);
}

.splitter{width:6px;background:var(--border);cursor:col-resize;transition:background .15s;flex-shrink:0}
.splitter:hover{background:var(--accent)}

/* Conversation */
.conversation{display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-base)}
.chat-header{height:46px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg-elevated)}
.chat-header-title{font-size:13px;font-weight:600;color:var(--text-primary)}
.chat-header-meta{font-size:11px;color:var(--text-tertiary);display:flex;align-items:center;gap:6px}
.chat-header-meta .dot{width:6px;height:6px;border-radius:50%;background:var(--success)}
.chat{flex:1;overflow-y:auto;padding:20px 16px;display:flex;flex-direction:column;gap:14px}
.empty-chat{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:40px 20px;gap:14px}
.empty-chat-icon{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,var(--bg-elevated-2) 0%,var(--bg-elevated-3) 100%);display:grid;place-items:center;color:var(--text-tertiary);border:1px solid var(--border)}
.empty-chat-icon svg{width:26px;height:26px}
.empty-chat-title{font-size:17px;font-weight:600;color:var(--text-primary);letter-spacing:-.01em;margin:0}
.empty-chat-desc{font-size:13px;color:var(--text-secondary);max-width:360px;line-height:1.5;margin:0}
.empty-chat-examples{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:460px;margin-top:6px}
.empty-chat-example{padding:6px 11px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--text-secondary);cursor:pointer;transition:var(--transition)}
.empty-chat-example:hover{background:var(--bg-elevated-2);color:var(--text-primary);border-color:var(--border-strong)}
.message{display:flex;gap:10px;max-width:100%;animation:messageIn .2s ease-out}
@keyframes messageIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.message-avatar{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;font-size:11px;font-weight:600;background:var(--bg-elevated-2);color:var(--text-secondary);border:1px solid var(--border)}
.message.user .message-avatar{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.message-body{flex:1;min-width:0}
.message-meta{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.message-author{font-size:12px;font-weight:600;color:var(--text-primary)}
.message-time{font-size:10px;color:var(--text-tertiary)}
.message-content{font-size:13.5px;line-height:1.6;color:var(--text-primary);overflow-wrap:break-word}
.message-content .md-h1{font-size:17px;font-weight:700;margin:10px 0 5px;color:#fff}
.message-content .md-h2{font-size:15px;font-weight:600;margin:8px 0 5px;color:#fff}
.message-content .md-h3{font-size:13.5px;font-weight:600;margin:6px 0 3px;color:#e4e4e7}
.message-content strong{font-weight:600;color:#fff}
.message-content .md-inline-code{font-family:'JetBrains Mono',monospace;font-size:11.5px;padding:2px 5px;background:var(--bg-elevated-2);border:1px solid var(--border);border-radius:4px;color:#93c5fd}
.message-content .md-code-block{margin:8px 0;padding:10px 12px;background:#0d0e12;border:1px solid var(--border);border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#93c5fd;overflow-x:auto;line-height:1.5}
.message-content .md-ul{margin:6px 0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.message-content .md-li{margin-bottom:2px}
.timeline{margin-top:4px;padding:12px 14px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md)}
.timeline-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.timeline-title{font-size:11px;font-weight:600;color:var(--text-primary);text-transform:uppercase;letter-spacing:.04em}
.timeline-timer{font-size:11px;color:var(--text-tertiary);font-family:'JetBrains Mono',monospace}
.timeline-steps{display:flex;flex-direction:column;gap:5px}
.timeline-step{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--text-tertiary);padding:3px 0}
.timeline-step .step-icon{width:16px;height:16px;display:grid;place-items:center;flex-shrink:0;color:var(--text-quaternary)}
.timeline-step .step-icon svg{width:13px;height:13px}
.timeline-step.done{color:var(--text-primary)}
.timeline-step.done .step-icon{color:var(--success)}
.timeline-step.active{color:var(--accent);font-weight:500}
.timeline-step.active .step-icon{color:var(--accent);animation:spin 1s linear infinite}
.timeline-step.error{color:var(--danger)}
.timeline-step.error .step-icon{color:var(--danger)}
@keyframes spin{to{transform:rotate(360deg)}}

.composer{padding:12px 16px 16px;border-top:1px solid var(--border);background:var(--bg-elevated);flex-shrink:0}
.compose-wrap{display:flex;gap:8px;align-items:flex-end;background:var(--bg-base);border:1px solid var(--border-strong);border-radius:var(--radius-lg);padding:8px 12px;transition:var(--transition)}
.compose-wrap:focus-within{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.prompt{flex:1;background:transparent;border:0;outline:none;resize:none;max-height:160px;min-height:22px;line-height:1.5;font-size:13.5px}
.prompt::placeholder{color:var(--text-tertiary)}
.send{display:flex;align-items:center;gap:6px;padding:7px 12px;background:var(--accent);color:var(--accent-fg);border-radius:var(--radius);font-size:12px;font-weight:600;flex-shrink:0;transition:var(--transition)}
.send:hover:not(:disabled){background:#e4e4e7}
.send:disabled{opacity:.4;cursor:not-allowed}
.send.sending svg{animation:spin 1s linear infinite}
.send svg{width:13px;height:13px}
.compose-footer{display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--text-tertiary)}
.compose-hint .kbd{padding:1px 5px;background:var(--bg-elevated-2);border:1px solid var(--border);border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:10px}
.scroll-bottom{position:absolute;bottom:80px;right:24px;width:32px;height:32px;border-radius:50%;background:var(--bg-elevated-2);border:1px solid var(--border);color:var(--text-primary);display:none;place-items:center;cursor:pointer;box-shadow:var(--shadow);transition:var(--transition);z-index:10}
.scroll-bottom:hover{background:var(--bg-elevated-3)}
.scroll-bottom svg{width:15px;height:15px}

/* Files Inspector */
.files-inspector{
  display:none;
  flex:1;
  height:100%;
  overflow:hidden;
  background:var(--bg-base);
}
.files-inspector.active{
  display:grid;
  grid-template-columns:220px 1fr;
}
.files-tree{
  border-right:1px solid var(--border);
  background:var(--bg-elevated);
  overflow-y:auto;
  padding:8px;
  display:flex;
  flex-direction:column;
  gap:2px;
}
.files-tree-title{
  font-size:11px;
  font-weight:600;
  text-transform:uppercase;
  letter-spacing:.06em;
  color:var(--text-tertiary);
  padding:4px 6px 8px;
}
.file-tree-item{
  display:flex;
  align-items:center;
  gap:6px;
  padding:6px 8px;
  border-radius:var(--radius-sm);
  font-size:12px;
  color:var(--text-secondary);
  cursor:pointer;
  font-family:'JetBrains Mono',monospace;
  transition:var(--transition);
}
.file-tree-item:hover{background:var(--bg-elevated-2);color:var(--text-primary)}
.file-tree-item.active{background:var(--bg-elevated-3);color:var(--text-primary);font-weight:600}
.file-viewer{
  display:flex;
  flex-direction:column;
  height:100%;
  overflow:hidden;
  background:#090a0d;
}
.file-viewer-header{
  height:40px;
  padding:0 12px;
  border-bottom:1px solid var(--border);
  display:flex;
  align-items:center;
  justify-content:space-between;
  background:var(--bg-elevated);
  font-family:'JetBrains Mono',monospace;
  font-size:12px;
  color:var(--text-secondary);
  flex-shrink:0;
}
.file-viewer-actions{display:flex;gap:6px}
.file-viewer-btn{
  display:flex;
  align-items:center;
  gap:4px;
  padding:3px 8px;
  background:var(--bg-elevated-2);
  border:1px solid var(--border);
  border-radius:4px;
  font-size:11px;
  color:var(--text-secondary);
  cursor:pointer;
  transition:var(--transition);
}
.file-viewer-btn:hover{color:var(--text-primary);border-color:var(--border-strong)}
.file-viewer-btn svg{width:12px;height:12px}
.file-viewer-content{
  flex:1;
  overflow:auto;
  padding:14px;
  margin:0;
  font-family:'JetBrains Mono',monospace;
  font-size:12px;
  color:#e4e4e7;
  line-height:1.6;
  white-space:pre;
}

/* Preview Section */
.preview{display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-base)}
.preview-header{height:46px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg-elevated)}
.preview-title{display:flex;align-items:center;gap:10px}
.preview-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-tertiary)}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--text-quaternary)}
.preview-status.ready .status-dot{background:var(--success)}
.preview-status.ready{color:var(--text-secondary)}
.preview-status.loading .status-dot{background:var(--info);animation:pulse 1.5s ease-in-out infinite}
.preview-status.loading{color:var(--text-secondary)}
.preview-status.error .status-dot{background:var(--danger)}
.preview-status.error{color:var(--danger)}
.preview-actions{display:flex;align-items:center;gap:4px}
.preview-actions button{width:28px;height:28px;display:grid;place-items:center;border-radius:var(--radius);color:var(--text-secondary);transition:var(--transition)}
.preview-actions button:hover:not(:disabled){background:var(--bg-elevated-2);color:var(--text-primary)}
.preview-actions button:disabled{opacity:.4;cursor:not-allowed}
.preview-actions button.active{background:var(--bg-elevated-3);color:var(--text-primary)}
.preview-actions button svg{width:15px;height:15px}
.preview-frame{flex:1;display:flex;align-items:center;justify-content:center;background:#050506;overflow:hidden;position:relative;min-height:0}
.preview-frame-content{width:100%;height:100%;position:relative;background:#fff;transition:max-width var(--transition)}
.preview-frame.mobile .preview-frame-content, .preview-frame.mobile-view .preview-frame-content, .mobile-view{max-width:390px;height:92%;border:1px solid var(--border-strong);border-radius:24px;box-shadow:var(--shadow-lg);overflow:hidden}
.error-card{background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:var(--radius);padding:12px 14px;margin:8px 0}
.error-card-title{font-size:13px;font-weight:600;color:var(--danger);margin-bottom:4px}
.error-card-desc{font-size:12px;color:var(--text-secondary);line-height:1.4}
.error-card-action{margin-top:8px;padding:5px 10px;background:var(--danger);color:#fff;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;border:none}
.error-card-details{margin-top:6px;font-size:11px;color:var(--text-tertiary)}
.files-changed{margin-top:8px;padding:8px 10px;background:var(--bg-elevated-2);border-radius:var(--radius);border:1px solid var(--border)}
.files-changed-file{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-secondary)}
iframe{width:100%;height:100%;border:0;background:#fff;display:block}

.preview-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px;gap:14px;background:radial-gradient(ellipse at center,var(--bg-elevated) 0%,var(--bg-base) 70%);z-index:2}
.preview-empty-icon{width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,var(--bg-elevated-2) 0%,var(--bg-elevated-3) 100%);display:grid;place-items:center;color:var(--text-tertiary);border:1px solid var(--border)}
.preview-empty-icon svg{width:28px;height:28px}
.preview-empty-title{font-size:16px;font-weight:600;color:var(--text-primary);margin:0}
.preview-empty-desc{font-size:13px;color:var(--text-secondary);max-width:320px;line-height:1.5;margin:0}
.preview-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(10,10,11,.9);backdrop-filter:blur(4px);z-index:5}
.preview-loading-spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin .8s linear infinite}
.preview-loading-text{font-size:13px;color:var(--text-secondary);font-weight:500}
.preview-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px;gap:14px;background:var(--bg-elevated);z-index:5}
.preview-error-icon{width:60px;height:60px;border-radius:50%;background:var(--danger-bg);border:1px solid var(--danger-border);display:grid;place-items:center;color:var(--danger)}
.preview-error-icon svg{width:26px;height:26px}
.preview-error-title{font-size:16px;font-weight:600;color:var(--text-primary);margin:0}
.preview-error-desc{font-size:13px;color:var(--text-secondary);max-width:340px;line-height:1.5;margin:0}
.preview-error-actions{display:flex;gap:8px;margin-top:8px}
.preview-error-btn{display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--accent);color:var(--accent-fg);border-radius:var(--radius);font-size:12px;font-weight:600;transition:var(--transition)}
.preview-error-btn:hover{background:#e4e4e7}
.preview-error-btn svg{width:14px;height:14px}
.preview-url-bar{padding:6px 14px;border-top:1px solid var(--border);background:var(--bg-elevated);font-size:11px;color:var(--text-tertiary);font-family:'JetBrains Mono',monospace;display:flex;align-items:center;gap:8px;flex-shrink:0;min-height:30px}
.preview-url-bar a{color:var(--text-secondary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.preview-url-bar a:hover{color:var(--text-primary)}

/* Modals */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:3000;align-items:center;justify-content:center;padding:20px}
.modal-overlay.show{display:flex;animation:modalIn .15s ease-out}
.modal-content{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);padding:22px;width:420px;max-width:100%;box-shadow:var(--shadow-xl)}
.modal-title{font-size:16px;font-weight:600;color:var(--text-primary);margin:0 0 4px}
.modal-desc{font-size:13px;color:var(--text-secondary);margin:0 0 16px;line-height:1.5}
.modal-label{font-size:12px;font-weight:500;color:var(--text-secondary);margin-bottom:6px;display:block}
.modal-input{width:100%;border:1px solid var(--border-strong);background:var(--bg-base);color:var(--text-primary);border-radius:var(--radius);padding:9px 12px;outline:none;font-family:inherit;font-size:13.5px;margin-bottom:16px;transition:var(--transition)}
.modal-input:focus{border-color:var(--accent)}
.modal-actions{display:flex;gap:8px;justify-content:flex-end}
.modal-actions button{padding:8px 14px;border-radius:var(--radius);font-size:12.5px;font-weight:500;transition:var(--transition);border:1px solid var(--border)}
.modal-actions button.ghost{background:transparent;color:var(--text-secondary)}
.modal-actions button.ghost:hover{background:var(--bg-elevated-2);color:var(--text-primary)}
.modal-actions button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
.modal-actions button.primary:hover{background:#e4e4e7}
.modal-actions button.danger{background:var(--danger);color:#fff;border-color:var(--danger);font-weight:600}
.modal-actions button.danger:hover{background:#dc2626}

.mobile-preview-btn{position:fixed;top:12px;right:12px;z-index:100;width:40px;height:40px;display:none;align-items:center;justify-content:center;background:var(--bg-elevated-2);border:1px solid var(--border);border-radius:50%;color:var(--text-primary);box-shadow:var(--shadow)}
.mobile-preview-btn svg{width:18px;height:18px}
.mobile-back-btn{position:fixed;top:12px;left:12px;z-index:100;width:40px;height:40px;display:none;align-items:center;justify-content:center;background:var(--bg-elevated-2);border:1px solid var(--border);border-radius:50%;color:var(--text-primary);box-shadow:var(--shadow)}
.mobile-back-btn svg{width:18px;height:18px}

@media(max-width:900px){
  .app{flex-direction:column}
  .sidebar{display:none}
  .workspace-panes{grid-template-columns:1fr;grid-template-rows:1fr}
  .left-panes{display:flex}
  .preview,.splitter{display:none}
  .app.preview-mode .left-panes{display:none}
  .app.preview-mode .preview{display:flex;position:fixed;inset:0;z-index:50;background:var(--bg-base)}
  .app.preview-mode .mobile-back-btn{display:flex}
  .app:not(.preview-mode) .mobile-preview-btn{display:flex}
}
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="sidebar" id="sidebar" role="navigation" aria-label="Projetos">
    <div class="sidebar-header">
      <div class="brand" id="brandBtn" title="PUB Prototype 2.0">
        <div class="brand-mark">P</div>
        <span>Prototype</span>
      </div>
      <button class="icon-btn" id="collapseSidebar" title="Recolher barra lateral" aria-label="Recolher barra lateral">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7"/></svg>
      </button>
    </div>
    <div class="projects-section">
      <div class="projects-header">
        <span class="projects-header-label">Projetos</span>
        <button class="btn-new" id="newProject" title="Criar novo projeto" aria-label="Novo projeto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          <span>Novo</span>
        </button>
      </div>
      <div class="projects-list" id="projectsList"></div>
    </div>
    <div class="sidebar-footer">
      <div class="session-info" id="sessionBox"></div>
    </div>
  </aside>

  <div class="main-area">
    <header class="topbar">
      <div class="topbar-left">
        <button class="icon-btn" id="expandSidebarBtn" title="Expandir barra lateral" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19l7-7-7-7"/></svg>
        </button>
        <div class="workspace-badge" title="Workspace ativo">
          <span>🏢</span>
          <span id="topbarWorkspace">Default Workspace</span>
        </div>
        <div class="project-title-editor">
          <span id="topbarProjectTitle" class="project-title-text">Sem projeto</span>
          <button id="renameProjectBtn" class="btn-edit-title" title="Renomear projeto" aria-label="Renomear projeto">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
        </div>
        <div class="branch-badge" id="branchPill" title="Git branch ativa">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg>
          <span id="topbarBranch">prototype/main</span>
        </div>
      </div>

      <div class="topbar-center">
        <div class="nav-tabs" role="tablist">
          <button class="nav-tab active" data-tab="chat" role="tab" aria-selected="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>Agente</span>
          </button>
          <button class="nav-tab" data-tab="preview" role="tab" aria-selected="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <span>Preview</span>
          </button>
          <button class="nav-tab" data-tab="files" role="tab" aria-selected="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>Arquivos</span>
          </button>
        </div>
      </div>

      <div class="topbar-right">
        <button class="topbar-btn" id="topbarRestartPreview" title="Reiniciar servidor de preview">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Reiniciar</span>
        </button>
        <a class="topbar-btn primary" id="topbarOpenPreview" target="_blank" rel="noopener noreferrer" href="#" title="Abrir preview em nova aba">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
          <span>Abrir</span>
        </a>
        <div class="user-pill" title="Usuário autenticado">
          <div class="user-avatar-sm">U</div>
          <span class="role-badge">OWNER</span>
        </div>
      </div>
    </header>

    <div class="workspace-panes" id="workspacePanes">
      <div class="left-panes" id="leftPanes">
        <section class="conversation" id="conversation">
          <div class="chat-header">
            <div class="chat-header-title" id="chatHeaderTitle">Sem projeto ativo</div>
            <div class="chat-header-meta" id="chatHeaderMeta">
              <span class="dot"></span>
              <span id="chatHeaderStatus">Aguardando</span>
            </div>
          </div>
          <div class="chat" id="chat"></div>
          <div class="composer">
            <div class="compose-wrap" id="composeWrap">
              <textarea id="prompt" class="prompt" placeholder="Descreva o que você quer construir..." rows="2"></textarea>
              <button id="send" class="send" disabled aria-label="Enviar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
                <span>Enviar</span>
              </button>
            </div>
            <div class="compose-footer">
              <div class="compose-hint">
                <span class="kbd">Enter</span> para enviar
                <span class="kbd">Shift+Enter</span> para nova linha
              </div>
              <div id="composeStatus"></div>
              <div id="taskTimer" style="font-size:11px;color:var(--text-tertiary);font-family:'JetBrains Mono',monospace;margin-top:4px;display:none"></div>
            </div>
            <button id="scrollBottom" class="scroll-bottom" aria-label="Rolar para baixo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
            </button>
          </div>
        </section>

        <!-- Files Inspector -->
        <div class="files-inspector" id="filesInspector">
          <div class="files-tree">
            <div class="files-tree-title">Arquivos do Projeto</div>
            <div id="filesTreeList" style="display:flex;flex-direction:column;gap:2px"></div>
          </div>
          <div class="file-viewer">
            <div class="file-viewer-header">
              <span id="fileViewerPath">index.html</span>
              <div class="file-viewer-actions">
                <button class="file-viewer-btn" id="copyFileBtn">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  <span>Copiar</span>
                </button>
              </div>
            </div>
            <pre class="file-viewer-content" id="fileViewerContent">// Selecione um arquivo para visualizar o código</pre>
          </div>
        </div>
      </div>

      <div class="splitter" id="splitter"></div>

      <section class="preview" id="preview" aria-label="Preview">
        <div class="preview-header">
          <div class="preview-title">
            <div class="preview-status idle" id="previewStatus">
              <span class="status-dot"></span>
              <span id="previewStatusLabel">Aguardando projeto</span>
            </div>
          </div>
          <div class="preview-actions">
            <button id="mobilePreviewBtn" title="Visualização mobile" aria-label="Visualização mobile">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>
            </button>
            <button id="refresh" title="Recarregar preview" aria-label="Recarregar" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 12a9 9 0 0 0 15 6.7L21 16M21 3v5h-5M3 21v-5h5"/></svg>
            </button>
            <button id="open" title="Abrir em nova aba" aria-label="Abrir" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
            </button>
            <button id="fullscreen" title="Tela cheia" aria-label="Tela cheia" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            </button>
          </div>
        </div>
        <div class="preview-frame" id="previewFrameContainer">
          <div class="preview-frame-content" id="frame">
            <div class="preview-empty" id="previewEmpty">
              <div class="preview-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
              </div>
              <h3 class="preview-empty-title" id="previewEmptyTitle">Aguardando projeto</h3>
              <p class="preview-empty-desc" id="previewEmptyDesc">Descreva o que você quer criar e o PUB Prototype começa a construir.</p>
            </div>
            <div class="preview-loading" id="previewLoading" style="display:none">
              <div class="preview-loading-spinner"></div>
              <div class="preview-loading-text" id="previewLoadingText">Preparando preview nativo...</div>
            </div>
            <div class="preview-error" id="previewError" style="display:none">
              <div class="preview-error-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
              </div>
              <h3 class="preview-error-title" id="previewErrorTitle">Preview indisponível</h3>
              <p class="preview-error-desc" id="previewErrorDesc">O servidor de preview precisa ser reconectado.</p>
              <div class="preview-error-actions">
                <button class="preview-error-btn" id="previewErrorRetry">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 12a9 9 0 0 0 15 6.7L21 16M21 3v5h-5M3 21v-5h5"/></svg>
                  Reconectar preview
                </button>
              </div>
            </div>
            <iframe id="iframe" title="Preview do projeto" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
          </div>
        </div>
        <div class="preview-url-bar" id="previewUrlBar" style="display:none">
          <a id="previewUrl" target="_blank" rel="noopener noreferrer">—</a>
        </div>
      </section>
    </div>
  </div>
</div>

<button class="mobile-preview-btn" id="mobilePreviewShowBtn" aria-label="Mostrar preview">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
</button>
<button class="mobile-back-btn" id="mobileBackBtn" aria-label="Voltar">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
</button>

<!-- New Project Modal -->
<div class="modal-overlay" id="newProjectModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="modal-content">
    <h2 class="modal-title" id="modalTitle">Novo projeto</h2>
    <p class="modal-desc">Dê um nome ao seu projeto. Você poderá descrevê-lo e iniciar a geração na próxima etapa.</p>
    <label class="modal-label" for="newProjectName">Nome do projeto</label>
    <input type="text" class="modal-input" id="newProjectName" placeholder="Ex: Sistema para Padaria" maxlength="60" autocomplete="off">
    <div class="modal-actions">
      <button id="cancelNewProject" class="ghost">Cancelar</button>
      <button id="confirmNewProject" class="primary">Criar projeto</button>
    </div>
  </div>
</div>

<!-- Rename Project Modal -->
<div class="modal-overlay" id="renameProjectModal" role="dialog" aria-modal="true" aria-labelledby="renameModalTitle">
  <div class="modal-content">
    <h2 class="modal-title" id="renameModalTitle">Renomear projeto</h2>
    <p class="modal-desc">Atualize o nome deste projeto no workspace.</p>
    <label class="modal-label" for="renameProjectInput">Novo nome</label>
    <input type="text" class="modal-input" id="renameProjectInput" maxlength="60" autocomplete="off">
    <div class="modal-actions">
      <button id="cancelRenameProject" class="ghost">Cancelar</button>
      <button id="confirmRenameProject" class="primary">Salvar</button>
    </div>
  </div>
</div>

<!-- Delete Project Confirmation Modal -->
<div class="modal-overlay" id="deleteProjectModal" role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle">
  <div class="modal-content">
    <h2 class="modal-title" id="deleteModalTitle">Excluir projeto</h2>
    <p class="modal-desc">
      Tem certeza de que deseja excluir o projeto <strong id="deleteTargetName" style="color:#fafafa"></strong>?<br><br>
      <span style="color:#ef4444;font-size:12px">⚠️ Todas as sessões, mensagens, tarefas e checkpoints locais serão excluídos.</span><br>
      <span style="color:#22c55e;font-size:12px">🔒 O repositório remoto no GitHub NÃO será afetado.</span>
    </p>
    <div class="modal-actions">
      <button id="cancelDeleteProject" class="ghost">Cancelar</button>
      <button id="confirmDeleteProject" class="danger">Excluir projeto permanentemente</button>
    </div>
  </div>
</div>

<script>
let sessionId = null, source = null, currentUrl = null, activeTimeline = null, checkpoints = [], loadSessionAt = 0;
let currentTaskId = null, activeTaskStatus = null, taskStartAt = null, timerInterval = null;
let projectsCache = [];
let previewState = 'idle';
let currentError = null;
let activeTab = 'chat';
let pendingDeleteProject = null;

const STORAGE_KEY = 'pub-prototype:last-session';
const STEP_ORDER = ['USER_PROMPT','AGENT_STARTED','AGENT_OUTPUT','BUILD_STARTED','BUILD_PASSED','PREVIEW_STARTED','PREVIEW_READY'];
const STEP_LABELS = {
  'USER_PROMPT':'Seu pedido',
  'AGENT_STARTED':'Agente iniciado',
  'AGENT_OUTPUT':'Gerando código',
  'BUILD_STARTED':'Validando',
  'BUILD_PASSED':'Build aprovado',
  'PREVIEW_STARTED':'Subindo preview',
  'PREVIEW_READY':'Pronto'
};

function $(id){ return document.getElementById(id); }
function $$(sel){ return document.querySelectorAll(sel); }

const HOST_ORIGIN = 'https://pubcore.site';
const HOST_LOGIN_URL = 'https://pubcore.site/login';
let activeRefreshPromise = null;

function getAuthToken() {
  const token = localStorage.getItem('pub-prototype:token');
  if (token) return token;

  // Fallback: Se executando sob o mesmo domínio/localStorage do Host, ler a chave de sessão Supabase
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sb-') && key.endsWith('-auth-token') || key === 'supabase.auth.token')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          const candidate = parsed?.access_token || parsed?.currentSession?.access_token;
          if (typeof candidate === 'string' && candidate) {
            localStorage.setItem('pub-prototype:token', candidate);
            return candidate;
          }
        }
      }
    }
  } catch {}

  // Allow test-token only in non‑production environments, safely checking for process availability
  if (typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')) {
    return 'test-token';
  }
  return undefined;
}

// Escuta atualizações de token enviadas pelo Host (via postMessage) com validação de origin
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const isAllowedOrigin = event.origin === HOST_ORIGIN || (Boolean(window.location?.origin) && event.origin === window.location.origin);
    if (!isAllowedOrigin) return;
    const data = event.data;
    if (data && data.type === 'PUB_AUTH_TOKEN_UPDATE' && typeof data.token === 'string' && data.token.trim()) {
      localStorage.setItem('pub-prototype:token', data.token.trim());
      // Notifica listeners locais
      window.dispatchEvent(new CustomEvent('pp:token-updated', { detail: { token: data.token.trim() } }));
    }
  });
}

function showSessionExpiredUi() {
  const chat = $('chat');
  if (chat) {
    const existing = document.getElementById('ppSessionExpiredBanner');
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = 'ppSessionExpiredBanner';
      banner.style.cssText = 'margin:12px;padding:16px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);border-radius:10px;text-align:center;color:#fafafa;';
      banner.innerHTML = '<div style="font-weight:700;font-size:14px;color:#ef4444;margin-bottom:6px">Sessão Expirada</div>' +
        '<div style="font-size:12px;color:#a1a1aa;margin-bottom:12px;line-height:1.5">Sua sessão no PUB Core expirou. Faça login novamente para continuar.</div>' +
        '<a href="' + HOST_LOGIN_URL + '" target="_top" style="display:inline-block;padding:7px 16px;background:#ef4444;color:#fff;font-size:12px;font-weight:600;border-radius:6px;text-decoration:none">Entrar novamente</a>';
      chat.appendChild(banner);
      chat.scrollTop = chat.scrollHeight;
    }
  }
  const composeStatus = $('composeStatus');
  if (composeStatus) composeStatus.textContent = 'Sessão expirada. Autentique-se novamente.';
}

async function requestTokenRefreshFromHost(oldToken) {
  if (activeRefreshPromise) return activeRefreshPromise;

  activeRefreshPromise = (async () => {
    // 1. Verifica se o token no storage já foi renovado
    const current = getAuthToken();
    if (current && current !== oldToken) {
      return current;
    }

    // 2. Solicita renovação ao Host via postMessage seguro
    if (typeof window !== 'undefined') {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'PUB_AUTH_REFRESH_REQUEST' }, HOST_ORIGIN);
        } else if (window.opener) {
          window.opener.postMessage({ type: 'PUB_AUTH_REFRESH_REQUEST' }, HOST_ORIGIN);
        }
      } catch {}
    }

    // 3. Aguarda janela de até 2000ms para receber PUB_AUTH_TOKEN_UPDATE ou storage update
    const timeoutMs = 2000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 200));
      const updated = getAuthToken();
      if (updated && updated !== oldToken) {
        return updated;
      }
    }
    return null;
  })().finally(() => {
    activeRefreshPromise = null;
  });

  return activeRefreshPromise;
}

async function apiFetch(url, opts = {}, isRetry = false) {
  const headers = new Headers(opts.headers || {});
  const token = getAuthToken();
  if (token && !headers.has('Authorization') && !headers.has('authorization')) {
    headers.set('Authorization', 'Bearer ' + token);
  }

  const response = await fetch(url, { ...opts, headers });

  // Tratamento de 401 com no máximo 1 retry
  if (response.status === 401 && !isRetry) {
    const refreshedToken = await requestTokenRefreshFromHost(token);
    if (refreshedToken && refreshedToken !== token) {
      const retryHeaders = new Headers(opts.headers || {});
      retryHeaders.set('Authorization', 'Bearer ' + refreshedToken);
      return apiFetch(url, { ...opts, headers: retryHeaders }, true);
    }
    // Falha persistente: notifica UI
    showSessionExpiredUi();
  }

  return response;
}

globalThis.apiFetch = apiFetch;

function clearStaleErrors() {
  document.querySelectorAll('.error-card').forEach(el => el.remove());
}

function renderErrorCard(title, desc, details, actionText, actionFn) {
  const el = document.createElement('div');
  el.className = 'error-card';
  el.innerHTML = '<div class="error-card-title">' + escapeHtml(title) + '</div>' +
    '<div class="error-card-desc">' + escapeHtml(desc) + '</div>' +
    (details ? '<details class="error-card-details"><summary>Detalhes</summary><pre>' + escapeHtml(details) + '</pre></details>' : '') +
    (actionText ? '<button class="error-card-action">' + escapeHtml(actionText) + '</button>' : '');
  if (actionText && actionFn) {
    el.querySelector('.error-card-action')?.addEventListener('click', actionFn);
  }
  return el;
}

async function probePreviewReachable(url) {
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 4000);
    await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
    clearTimeout(to);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatTime(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit'}) + ' ' + date.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
}

function getStatusClass(s) {
  if (!s) return 'creating';
  const st = s.toLowerCase();
  if (st === 'ready') return 'ready';
  if (st === 'building' || st === 'previewing') return 'building';
  if (st === 'failed') return 'failed';
  return 'creating';
}

function getStatusLabel(s) {
  if (!s) return 'Criando';
  const st = s.toLowerCase();
  if (st === 'ready') return 'Pronto';
  if (st === 'building') return 'Construindo';
  if (st === 'previewing') return 'Preparando';
  if (st === 'failed') return 'Erro';
  return 'Criando';
}

// === SIDEBAR COLLAPSE ===
function toggleSidebar() {
  const sidebar = $('sidebar');
  const expandBtn = $('expandSidebarBtn');
  const isCollapsed = sidebar.classList.toggle('collapsed');
  if (expandBtn) expandBtn.style.display = isCollapsed ? 'grid' : 'none';
  localStorage.setItem('pub-sidebar-collapsed', isCollapsed ? 'true' : 'false');
}

// === TABS ===
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-tab') === tab);
  });
  const conversation = $('conversation');
  const filesInspector = $('filesInspector');
  const preview = $('preview');
  const panes = $('workspacePanes');

  if (tab === 'chat') {
    conversation.style.display = 'flex';
    filesInspector.style.display = 'none';
    preview.style.display = 'flex';
    panes.classList.remove('fullscreen-preview');
  } else if (tab === 'files') {
    conversation.style.display = 'none';
    filesInspector.style.display = 'grid';
    filesInspector.classList.add('active');
    preview.style.display = 'flex';
    panes.classList.remove('fullscreen-preview');
    if (sessionId) loadFilesInspector(sessionId);
  } else if (tab === 'preview') {
    conversation.style.display = 'none';
    filesInspector.style.display = 'none';
    preview.style.display = 'flex';
    panes.classList.add('fullscreen-preview');
  }
}

// === FILES INSPECTOR ===
async function loadFilesInspector(sid) {
  const treeList = $('filesTreeList');
  const content = $('fileViewerContent');
  const pathLabel = $('fileViewerPath');
  if (!treeList) return;
  treeList.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--text-tertiary)">Carregando arquivos...</div>';
  try {
    const r = await apiFetch('/prototype/sessions/' + encodeURIComponent(sid) + '/files');
    if (!r.ok) throw new Error('Falha ao carregar lista de arquivos');
    const data = await r.json();
    const files = data.files || [];
    if (files.length === 0) {
      treeList.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--text-tertiary)">Nenhum arquivo gerado ainda.</div>';
      content.textContent = '// Os arquivos serão listados aqui assim que o build for concluído.';
      pathLabel.textContent = 'Nenhum arquivo';
      return;
    }
    treeList.innerHTML = '';
    files.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = 'file-tree-item' + (idx === 0 ? ' active' : '');
      item.innerHTML = '<span>📄</span><span>' + escapeHtml(f.path) + '</span>';
      item.addEventListener('click', () => {
        treeList.querySelectorAll('.file-tree-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        viewFile(sid, f.path);
      });
      treeList.appendChild(item);
    });
    viewFile(sid, files[0].path);
  } catch (e) {
    treeList.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--danger)">Erro ao listar arquivos</div>';
  }
}

async function viewFile(sid, filePath) {
  const content = $('fileViewerContent');
  const pathLabel = $('fileViewerPath');
  pathLabel.textContent = filePath;
  content.textContent = '// Carregando ' + filePath + '...';
  try {
    const r = await apiFetch('/prototype/sessions/' + encodeURIComponent(sid) + '/files/' + encodeURIComponent(filePath));
    if (!r.ok) throw new Error('Arquivo não encontrado');
    const file = await r.json();
    content.textContent = file.content;
  } catch (e) {
    content.textContent = '// Erro ao ler conteúdo: ' + (e.message || String(e));
  }
}

// === PROJECT DELETION ===
function openDeleteModal(p) {
  pendingDeleteProject = p;
  $('deleteTargetName').textContent = p.project || 'este projeto';
  $('deleteProjectModal').classList.add('show');
}
function closeDeleteModal() {
  pendingDeleteProject = null;
  $('deleteProjectModal').classList.remove('show');
}
async function confirmDeleteProject() {
  if (!pendingDeleteProject) return;
  const p = pendingDeleteProject;
  closeDeleteModal();
  try {
    const r = await apiFetch('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' });
    const local = getLocalProjects().filter(item => item.id !== p.id);
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(local));
    projectsCache = projectsCache.filter(item => item.id !== p.id);
    renderProjects();
    if (sessionId === p.id) {
      if (projectsCache.length > 0) {
        selectProject(projectsCache[0].id);
      } else {
        showNewProjectModal();
      }
    }
  } catch (err) {
    alert('Erro ao excluir projeto: ' + (err.message || String(err)));
  }
}

// === PROJECT RENAMING ===
function openRenameModal() {
  const currentProj = projectsCache.find(p => p.id === sessionId);
  if (!currentProj) return;
  $('renameProjectInput').value = currentProj.project || '';
  $('renameProjectModal').classList.add('show');
  setTimeout(() => $('renameProjectInput').focus(), 100);
}
function closeRenameModal() {
  $('renameProjectModal').classList.remove('show');
}
async function confirmRenameProject() {
  const newName = $('renameProjectInput').value.trim();
  if (!newName || !sessionId) return;
  closeRenameModal();
  try {
    await apiFetch('/api/projects/' + encodeURIComponent(sessionId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    $('topbarProjectTitle').textContent = newName;
    $('chatHeaderTitle').textContent = newName;
    const p = projectsCache.find(item => item.id === sessionId);
    if (p) {
      p.project = newName;
      saveLocalProject(p);
      renderProjects();
    }
  } catch (e) {
    alert('Erro ao renomear projeto: ' + (e.message || String(e)));
  }
}

// === PREVIEW CONTROLS ===
function setPreviewState(state, opts) {
  previewState = state;
  const empty = $('previewEmpty');
  const loading = $('previewLoading');
  const err = $('previewError');
  const iframe = $('iframe');
  const status = $('previewStatus');
  const statusLabel = $('previewStatusLabel');
  const openBtn = $('open');
  const refreshBtn = $('refresh');
  const fullscreenBtn = $('fullscreen');

  empty.style.display = 'none';
  loading.style.display = 'none';
  err.style.display = 'none';
  status.className = 'preview-status ' + state;

  if (state === 'idle') {
    empty.style.display = 'flex';
    statusLabel.textContent = 'Aguardando projeto';
    openBtn.disabled = true;
    refreshBtn.disabled = true;
    fullscreenBtn.disabled = true;
  } else if (state === 'loading') {
    loading.style.display = 'flex';
    statusLabel.textContent = 'Carregando preview';
    openBtn.disabled = false;
    refreshBtn.disabled = false;
    fullscreenBtn.disabled = false;
  } else if (state === 'ready') {
    statusLabel.textContent = 'Preview pronto';
    openBtn.disabled = false;
    refreshBtn.disabled = false;
    fullscreenBtn.disabled = false;
  } else if (state === 'error') {
    err.style.display = 'flex';
    statusLabel.textContent = 'Preview indisponível';
    if (opts?.title) $('previewErrorTitle').textContent = opts.title;
    if (opts?.desc) $('previewErrorDesc').textContent = opts.desc;
    openBtn.disabled = true;
    refreshBtn.disabled = false;
    fullscreenBtn.disabled = true;
  } else if (state === 'recovering') {
    loading.style.display = 'flex';
    statusLabel.textContent = 'Reconectando preview';
    openBtn.disabled = true;
    refreshBtn.disabled = false;
    fullscreenBtn.disabled = true;
  }
}

function renderPreview(url) {
  if (!url) return;
  currentUrl = url;
  const iframe = $('iframe');
  if (!iframe) return;

  setPreviewState('loading');
  $('previewUrl').textContent = url;
  $('previewUrl').href = url;
  $('topbarOpenPreview').href = url;
  $('previewUrlBar').style.display = 'flex';

  iframe.addEventListener('load', () => { setPreviewState('ready'); });
  iframe.addEventListener('error', () => {
    showPreviewError({ title: 'Preview indisponível', desc: 'O preview não pôde ser renderizado no navegador.' });
  });

  iframe.src = url;
  setTimeout(() => {
    if (previewState === 'loading') setPreviewState('ready');
  }, 1200);
}

function showPreviewError(opts) {
  setPreviewState('error', opts);
}

async function triggerPreviewRecovery() {
  if (!sessionId) return;
  setPreviewState('recovering');
  try {
    const r = await apiFetch('/prototype/sessions/' + encodeURIComponent(sessionId) + '/preview/refresh', { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    const newUrl = data.previewUrl || '/prototype/sessions/' + encodeURIComponent(sessionId) + '/preview/';
    renderPreview(newUrl);
  } catch (e) {
    showPreviewError({ title: 'Preview indisponível', desc: e.message || 'Falha ao recuperar preview' });
  }
}

async function restartPreview() {
  return triggerPreviewRecovery();
}

// === LOCAL STORAGE PERSISTENCE ===
const LOCAL_PROJECTS_KEY = 'pub-prototype:local-projects';
function getLocalProjects() {
  try { return JSON.parse(localStorage.getItem(LOCAL_PROJECTS_KEY) || '[]'); } catch { return []; }
}
function saveLocalProject(session) {
  if (!session || !session.id) return;
  try {
    let list = getLocalProjects().filter(p => p.id !== session.id);
    list.unshift({ ...session, updatedAt: new Date().toISOString() });
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(list.slice(0, 50)));
  } catch {}
}

async function loadProjects() {
  try {
    let data = [];
    const r = await apiFetch('/prototype/sessions').catch(() => null);
    if (r && r.ok) {
      data = await r.json().catch(() => []);
    } else {
      const r2 = await apiFetch('/api/projects').catch(() => null);
      if (r2 && r2.ok) data = await r2.json().catch(() => []);
    }

    const localSessions = getLocalProjects();
    const map = new Map();
    (Array.isArray(data) ? data : []).forEach(p => {
      const projObj = {
        id: p.id,
        project: p.name || p.project || 'Sem nome',
        status: p.status || 'READY',
        updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
        branch: p.githubBranch || p.branch || ('prototype/' + (p.name || 'untitled') + '/' + p.id),
      };
      map.set(projObj.id, projObj);
    });

    localSessions.forEach(p => {
      if (!map.has(p.id)) {
        map.set(p.id, {
          id: p.id,
          project: p.project || p.name || 'Sem nome',
          status: p.status || 'READY',
          updatedAt: p.updatedAt || new Date().toISOString(),
          branch: p.branch || ('prototype/' + (p.project || 'untitled') + '/' + p.id),
        });
      }
    });

    projectsCache = Array.from(map.values()).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    renderProjects();
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
}

function renderProjects() {
  const list = $('projectsList');
  if (!list) return;
  list.innerHTML = '';
  if (!projectsCache.length) return;

  projectsCache.forEach(p => {
    const el = document.createElement('div');
    el.className = 'project-item' + (p.id === sessionId ? ' active' : '');
    el.setAttribute('data-id', p.id);
    el.setAttribute('title', p.project || 'Sem nome');
    el.innerHTML = '<span class="project-status ' + getStatusClass(p.status) + '"></span>' +
      '<div class="project-info">' +
        '<div class="project-name">' + escapeHtml(p.project || 'Sem nome') + '</div>' +
        '<div class="project-meta">' + getStatusLabel(p.status) + '<span class="dot"></span>' + formatTime(p.updatedAt) + '</div>' +
      '</div>' +
      '<button class="project-del-btn" title="Excluir projeto" aria-label="Excluir projeto">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
      '</button>';

    el.addEventListener('click', (e) => {
      if (e.target.closest('.project-del-btn')) return;
      selectProject(p.id);
    });

    const delBtn = el.querySelector('.project-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeleteModal(p);
      });
    }

    list.appendChild(el);
  });
}

function selectProject(id) {
  openProject(id);
}

async function openProject(id) {
  try {
    await loadSession(id);
  } catch (e) {
    console.error('Erro ao selecionar projeto:', e);
    addMessage('system', 'Erro ao carregar projeto: ' + (e?.message || String(e)));
  }
}

// === NEW PROJECT MODAL ===
function showNewProjectModal() {
  $('newProjectModal').classList.add('show');
  setTimeout(() => $('newProjectName').focus(), 100);
}
function hideNewProjectModal() {
  $('newProjectModal').classList.remove('show');
  $('newProjectName').value = '';
}
async function confirmNewProject() {
  const name = $('newProjectName').value.trim();
  if (!name) return;
  hideNewProjectModal();
  try {
    const r = await apiFetch('/prototype/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: name })
    });
    if (!r.ok) throw new Error('Falha ao criar projeto no servidor');
    const session = await r.json();
    saveLocalProject(session);
    localStorage.setItem(STORAGE_KEY, session.id);
    await loadProjects();
    await loadSession(session.id);
  } catch (e) {
    const localId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'local-' + Date.now();
    const fallbackSession = {
      id: localId,
      project: name,
      repository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
      branch: 'prototype/' + name.toLowerCase().replace(/[^a-z0-9-_]/g, '-') + '/' + localId,
      mode: 'PROTOTYPE',
      status: 'READY',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveLocalProject(fallbackSession);
    localStorage.setItem(STORAGE_KEY, localId);
    await loadProjects();
    await loadSession(localId);
  }
}

// === LOAD SESSION ===
async function loadSession(id) {
  loadSessionAt = Date.now();
  clearStaleErrors();
  const proj = projectsCache.find(p => p.id === id) || getLocalProjects().find(p => p.id === id);
  let data = null;
  try {
    const r = await apiFetch('/prototype/sessions/' + encodeURIComponent(id));
    if (r.ok) data = await r.json();
  } catch {}

  if (!data || !data.session) {
    if (proj) {
      data = { session: proj, checkpoints: [], tasks: [], messages: [] };
    } else {
      throw new Error('Sessão não encontrada');
    }
  }

  sessionId = data.session.id;
  localStorage.setItem(STORAGE_KEY, sessionId);
  saveLocalProject(data.session);

  const projectName = data.session.project || 'Sem nome';
  const branchName = data.session.branch || ('prototype/' + projectName + '/' + sessionId);

  $('topbarProjectTitle').textContent = projectName;
  $('chatHeaderTitle').textContent = projectName;
  $('topbarBranch').textContent = branchName;
  $('sessionBox').textContent = sessionId;
  $('chat').innerHTML = '';

  checkpoints = [...(data.checkpoints || [])];
  const messages = data.messages && data.messages.length ? data.messages : null;
  if (messages) {
    messages.forEach(m => {
      const role = m.role === 'user' ? 'user' : (m.role === 'assistant' || m.role === 'agent') ? 'agent' : 'system';
      addMessage(role, m.content || '', m.createdAt || m.timestamp);
    });
  } else {
    const completedTasks = (data.tasks || []).filter(t => t.status === 'COMPLETED' || t.status === 'FAILED');
    completedTasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    completedTasks.forEach(t => {
      if (t.prompt) addMessage('user', t.prompt, t.createdAt);
      const summary = t.result?.finalize?.summary || t.result?.summary || t.objective || null;
      if (summary) addMessage('agent', summary, t.updatedAt || t.createdAt);
    });
    if (!completedTasks.length) renderChatEmpty();
  }

  $('chatHeaderStatus').textContent = data.session.status === 'READY' ? 'Pronto' : data.session.status;
  $('chatHeaderMeta').querySelector('.dot').style.background = data.session.status === 'FAILED' ? 'var(--danger)' : (data.session.status === 'READY' ? 'var(--success)' : 'var(--warning)');
  renderProjects();

  // Load preview or set error state based on session status
  const nativePreviewUrl = '/prototype/sessions/' + encodeURIComponent(sessionId) + '/preview/';
  if (data.session.status === 'FAILED') {
    showPreviewError({
      title: 'Compilação com falha',
      desc: 'A geração deste protótipo falhou. Envie uma nova instrução pelo chat para tentar novamente.',
    });
  } else if (data.session.status === 'VERIFYING') {
    setPreviewState('loading');
    $('previewStatusLabel').textContent = 'Verificando integridade (V0..V5)...';
    renderPreview(nativePreviewUrl);
  } else if (data.session.status === 'READY') {
    renderPreview(nativePreviewUrl);
  } else {
    setPreviewState('loading');
    renderPreview(nativePreviewUrl);
  }

  const activeTask = (data.tasks || []).find(t => ['QUEUED','ASSIGNED','RUNNING','TESTING'].includes(t.status));
  if (activeTask) {
    currentTaskId = activeTask.id;
    activeTaskStatus = activeTask.status;
    $('send').classList.add('sending');
    $('composeStatus').textContent = 'Construindo...';
    startTaskTimer();
    startLivePoll(sessionId);
  } else {
    currentTaskId = null;
    activeTaskStatus = null;
    $('send').classList.remove('sending');
    $('composeStatus').textContent = '';
    stopTaskTimer();
  }

  connectSse(sessionId);
  updateSendButton();
}

// === CHAT & MARKDOWN FORMATTER ===
function formatMarkdown(text) {
  if (!text) return '';
  let str = escapeHtml(text);
  str = str.replace(/^### (.*$)/gm, '<h4 class="md-h3">$1</h4>');
  str = str.replace(/^## (.*$)/gm, '<h3 class="md-h2">$1</h3>');
  str = str.replace(/^# (.*$)/gm, '<h2 class="md-h1">$1</h2>');
  str = str.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
  str = str.replace(/\\*(.*?)\\*/g, '<em>$1</em>');
  str = str.replace(/\x60([^\x60]+)\x60/g, '<code class="md-inline-code">$1</code>');
  str = str.replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, '<pre class="md-code-block"><code>$1</code></pre>');
  str = str.replace(/^\\* (.*$)/gm, '<div class="md-li">• $1</div>');
  str = str.replace(/\\n/g, '<br/>');
  return str;
}

function addMessage(role, content, time) {
  const chat = $('chat');
  if (!chat) return;
  const empty = chat.querySelector('.empty-chat');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'message ' + role;
  const avatarText = role === 'user' ? 'U' : role === 'agent' ? 'AI' : 'ℹ️';
  const authorName = role === 'user' ? 'Você' : role === 'agent' ? 'PUB Agent' : 'Sistema';
  const timeFormatted = formatTime(time || new Date());

  el.innerHTML = '<div class="message-avatar">' + avatarText + '</div>' +
    '<div class="message-body">' +
      '<div class="message-meta">' +
        '<span class="message-author">' + authorName + '</span>' +
        '<span class="message-time">' + timeFormatted + '</span>' +
      '</div>' +
      '<div class="message-content">' + formatMarkdown(content) + '</div>' +
    '</div>';

  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function renderChatEmpty() {
  const chat = $('chat');
  if (!chat) return;
  chat.innerHTML = '<div class="empty-chat">' +
    '<div class="empty-chat-icon">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
    '</div>' +
    '<h3 class="empty-chat-title">O que vamos construir hoje?</h3>' +
    '<p class="empty-chat-desc">Descreva os recursos, telas ou integrações do seu app e o agente criará o protótipo executável.</p>' +
    '<div class="empty-chat-examples">' +
      '<div class="empty-chat-example" onclick="setPromptExample(this)">Dashboard SaaS com métricas financeiras</div>' +
      '<div class="empty-chat-example" onclick="setPromptExample(this)">Aplicativo de agendamento para barbearia</div>' +
      '<div class="empty-chat-example" onclick="setPromptExample(this)">Marketplace de produtos agrícolas</div>' +
    '</div>' +
  '</div>';
}

function setPromptExample(el) {
  const p = $('prompt');
  if (!p) return;
  p.value = el.textContent;
  p.focus();
  updateSendButton();
}

// === TIMELINE ===
function createTimeline() {
  const chat = $('chat');
  if (!chat) return null;
  const el = document.createElement('div');
  el.className = 'timeline';
  el.innerHTML = '<div class="timeline-header">' +
    '<span class="timeline-title">Execução do Agente</span>' +
    '<span class="timeline-timer" id="tlTimer">00:00</span>' +
  '</div>' +
  '<div class="timeline-steps" id="tlSteps">' +
    STEP_ORDER.map(s => '<div class="timeline-step" id="step_' + s + '"><span class="step-icon">○</span><span>' + STEP_LABELS[s] + '</span></div>').join('') +
  '</div>' +
  '<div class="files-changed" style="display:none;"><div class="files-changed-file"></div></div>';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function updateTimelineStep(type, status) {
  const stepEl = $('step_' + type);
  if (!stepEl) return;
  stepEl.className = 'timeline-step ' + status;
  const icon = stepEl.querySelector('.step-icon');
  if (icon) {
    if (status === 'done') icon.innerHTML = '✓';
    else if (status === 'active') icon.innerHTML = '◐';
    else if (status === 'error') icon.innerHTML = '✗';
  }
}

// === SSE CONNECTION ===
function connectSse(sid) {
  if (source) {
    source.close();
    source = null;
  }
  if (!sid) return;
  source = new EventSource('/prototype/sessions/' + encodeURIComponent(sid) + '/events');

  source.addEventListener('USER_PROMPT', e => {
    try {
      const data = JSON.parse(e.data);
      if (!activeTimeline) activeTimeline = createTimeline();
      updateTimelineStep('USER_PROMPT', 'done');
      updateTimelineStep('AGENT_STARTED', 'active');
    } catch {}
  });

  source.addEventListener('AGENT_STARTED', () => {
    updateTimelineStep('AGENT_STARTED', 'done');
    updateTimelineStep('AGENT_OUTPUT', 'active');
  });

  source.addEventListener('BUILD_STARTED', () => {
    updateTimelineStep('AGENT_OUTPUT', 'done');
    updateTimelineStep('BUILD_STARTED', 'active');
  });

  source.addEventListener('BUILD_PASSED', () => {
    updateTimelineStep('BUILD_STARTED', 'done');
    updateTimelineStep('PREVIEW_STARTED', 'active');
  });

  source.addEventListener('VERIFICATION_STARTED', () => {
    $('chatHeaderStatus').textContent = 'Verificando';
    $('chatHeaderMeta').querySelector('.dot').style.background = 'var(--warning)';
    $('previewStatusLabel').textContent = 'Verificando integridade (V0..V5)...';
  });

  source.addEventListener('VERIFICATION_PASSED', () => {
    $('previewStatusLabel').textContent = 'Verificação aprovada. Promovendo...';
  });

  source.addEventListener('VERIFICATION_FAILED', e => {
    try {
      const data = JSON.parse(e.data);
      showPreviewError({
        title: 'Verificação reprovada',
        desc: data.errorSummary || 'O protótipo não passou nos testes de validação obrigatória.',
      });
    } catch {}
  });

  source.addEventListener('PREVIEW_READY', e => {
    try {
      const data = JSON.parse(e.data);
      const eventSessionId = data.sessionId || data.session_id;
      if (eventSessionId && eventSessionId !== sessionId) return;
      if (Date.now() - loadSessionAt < 2000) return;
      updateTimelineStep('PREVIEW_STARTED', 'done');
      updateTimelineStep('PREVIEW_READY', 'done');
      $('chatHeaderStatus').textContent = 'Pronto';
      $('chatHeaderMeta').querySelector('.dot').style.background = 'var(--success)';
      stopTaskTimer();
      $('send').classList.remove('sending');
      $('composeStatus').textContent = '';
      activeTimeline = null;
      renderPreview(data.url || '/prototype/sessions/' + encodeURIComponent(sessionId) + '/preview/');
      loadProjects();
    } catch {}
  });

  source.addEventListener('ERROR', e => {
    try {
      const data = JSON.parse(e.data);
      if (activeTimeline) {
        STEP_ORDER.forEach(s => {
          const el = $('step_' + s);
          if (el && el.classList.contains('active')) updateTimelineStep(s, 'error');
        });
      }
      $('chatHeaderStatus').textContent = 'Erro';
      $('chatHeaderMeta').querySelector('.dot').style.background = 'var(--danger)';
      stopTaskTimer();
      $('send').classList.remove('sending');
      $('composeStatus').textContent = 'Erro';
      addMessage('system', 'Erro: ' + (data.message || 'Falha na execução'));
    } catch {}
  });

  source.onerror = () => {
    // Reconnect handled automatically by EventSource
  };
}

// === TASK POLLING & TIMER ===
let pollInterval = null;
function startLivePoll(sid) {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (!currentTaskId) {
      clearInterval(pollInterval);
      return;
    }
    try {
      const r = await apiFetch('/prototype/sessions/' + encodeURIComponent(sid));
      if (!r.ok) return;
      const data = await r.json();
      const currentTask = (data.tasks || []).find(t => t.id === currentTaskId);
      if (currentTask && (currentTask.status === 'COMPLETED' || currentTask.status === 'FAILED')) {
        clearInterval(pollInterval);
        currentTaskId = null;
        stopTaskTimer();
        $('send').classList.remove('sending');
        $('composeStatus').textContent = '';
        await loadSession(sid);
      }
    } catch {}
  }, 3000);
}

function startTaskTimer() {
  taskStartAt = Date.now();
  const timerEl = $('taskTimer');
  if (timerEl) timerEl.style.display = 'block';
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - taskStartAt) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = 'Tempo decorrido: ' + m + ':' + s;
    const tl = $('tlTimer');
    if (tl) tl.textContent = m + ':' + s;
  }, 1000);
}

function stopTaskTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  const timerEl = $('taskTimer');
  if (timerEl) timerEl.style.display = 'none';
}

// === SEND PROMPT ===
async function sendPrompt() {
  const promptInput = $('prompt');
  const prompt = promptInput.value.trim();
  if (!prompt || !sessionId) return;

  promptInput.value = '';
  updateSendButton();
  addMessage('user', prompt);

  $('send').classList.add('sending');
  $('composeStatus').textContent = 'Iniciando agente...';
  activeTimeline = createTimeline();
  updateTimelineStep('USER_PROMPT', 'done');
  updateTimelineStep('AGENT_STARTED', 'active');
  startTaskTimer();

  try {
    const r = await apiFetch('/prototype/sessions/' + encodeURIComponent(sessionId) + '/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao enviar prompt');
    }
    const data = await r.json();
    currentTaskId = data.task?.id || null;
    startLivePoll(sessionId);
  } catch (e) {
    stopTaskTimer();
    $('send').classList.remove('sending');
    $('composeStatus').textContent = '';
    addMessage('system', 'Erro: ' + (e.message || String(e)));
  }
}

function updateSendButton() {
  const val = $('prompt').value.trim();
  $('send').disabled = !val || !sessionId || $('send').classList.contains('sending');
}

// === SPLITTER & MOBILE ===
function initSplitter() {
  const splitter = $('splitter');
  if (!splitter) return;
  let isResizing = false;
  splitter.addEventListener('mousedown', e => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!isResizing) return;
    const panes = $('workspacePanes');
    const rect = panes.getBoundingClientRect();
    const leftWidth = e.clientX - rect.left;
    if (leftWidth > 240 && leftWidth < rect.width - 240) {
      panes.style.gridTemplateColumns = leftWidth + 'px 6px 1fr';
    }
  });
  window.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// === INITIALIZATION ===
async function initApp() {
  initSplitter();
  setPreviewState('idle');
  renderChatEmpty();

  // Sidebar toggle
  $('collapseSidebar').addEventListener('click', toggleSidebar);
  $('expandSidebarBtn').addEventListener('click', toggleSidebar);
  if (localStorage.getItem('pub-sidebar-collapsed') === 'true') {
    $('sidebar').classList.add('collapsed');
    $('expandSidebarBtn').style.display = 'grid';
  }

  // Modals
  $('newProject').addEventListener('click', showNewProjectModal);
  $('cancelNewProject').addEventListener('click', hideNewProjectModal);
  $('confirmNewProject').addEventListener('click', confirmNewProject);

  $('renameProjectBtn').addEventListener('click', openRenameModal);
  $('cancelRenameProject').addEventListener('click', closeRenameModal);
  $('confirmRenameProject').addEventListener('click', confirmRenameProject);

  $('cancelDeleteProject').addEventListener('click', closeDeleteModal);
  $('confirmDeleteProject').addEventListener('click', confirmDeleteProject);

  // Tabs
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  // Topbar Preview Controls
  $('topbarRestartPreview').addEventListener('click', restartPreview);
  $('refresh').addEventListener('click', () => {
    const iframe = $('iframe');
    if (iframe && iframe.src) iframe.src = iframe.src;
  });
  $('open').addEventListener('click', () => {
    if (currentUrl) window.open(currentUrl, '_blank');
  });
  $('fullscreen').addEventListener('click', () => {
    const panes = $('workspacePanes');
    panes.classList.toggle('fullscreen-preview');
  });
  $('mobilePreviewBtn').addEventListener('click', () => {
    $('previewFrameContainer').classList.toggle('mobile-view');
    $('mobilePreviewBtn').classList.toggle('active');
  });
  $('previewErrorRetry').addEventListener('click', triggerPreviewRecovery);

  // Copy code button in file viewer
  $('copyFileBtn').addEventListener('click', () => {
    const code = $('fileViewerContent').textContent;
    navigator.clipboard.writeText(code).then(() => {
      const span = $('copyFileBtn').querySelector('span');
      span.textContent = 'Copiado!';
      setTimeout(() => { span.textContent = 'Copiar'; }, 1500);
    });
  });

  // Composer events
  $('prompt').addEventListener('input', updateSendButton);
  $('prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  $('send').addEventListener('click', sendPrompt);

  // Mobile navigation
  $('mobilePreviewShowBtn').addEventListener('click', () => $('app').classList.add('preview-mode'));
  $('mobileBackBtn').addEventListener('click', () => $('app').classList.remove('preview-mode'));

  // Load projects
  await loadProjects();
  let targetId = localStorage.getItem(STORAGE_KEY);
  if (!targetId || !projectsCache.some(p => p.id === targetId)) {
    targetId = projectsCache.length > 0 ? projectsCache[0].id : null;
  }
  if (targetId) {
    await loadSession(targetId);
  } else {
    updateSendButton();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
</script>
</body>
</html>`;

  return html.trim();
}
