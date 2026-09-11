import { describe, it, expect } from 'vitest';
import { prototypeUiHtml } from '../src/pp/ui/ui.js';

describe('P1 UI — Empty States', () => {
  const html = prototypeUiHtml();

  it('renders the empty preview state', () => {
    expect(html).toContain('preview-empty');
    expect(html).toContain('Aguardando projeto');
  });

  it('renders the empty chat state structure', () => {
    expect(html).toContain('empty-chat');
  });

  it('renders example prompts in empty state', () => {
    expect(html).toContain('empty-chat-example');
  });

  it('has the preview status pill', () => {
    expect(html).toContain('preview-status');
    expect(html).toContain('previewStatusLabel');
  });
});

describe('P1 UI — Preview States', () => {
  const html = prototypeUiHtml();

  it('has loading state', () => {
    expect(html).toContain('preview-loading');
    expect(html).toContain('previewLoadingText');
  });

  it('has error state with retry button', () => {
    expect(html).toContain('preview-error');
    expect(html).toContain('previewErrorRetry');
    expect(html).toContain('Reconectar preview');
  });

  it('has iframe element', () => {
    expect(html).toContain('<iframe');
    expect(html).toContain('id="iframe"');
  });

  it('has preview controls (refresh, open, fullscreen, mobile)', () => {
    expect(html).toContain('id="refresh"');
    expect(html).toContain('id="open"');
    expect(html).toContain('id="fullscreen"');
    expect(html).toContain('id="mobilePreviewBtn"');
  });
});

describe('P1 UI — Composer', () => {
  const html = prototypeUiHtml();

  it('has composer with send button', () => {
    expect(html).toContain('id="prompt"');
    expect(html).toContain('id="send"');
    expect(html).toContain('Enviar');
  });

  it('shows keyboard shortcuts', () => {
    expect(html).toContain('kbd');
    expect(html).toContain('Enter');
    expect(html).toContain('Shift+Enter');
  });

  it('has placeholder text', () => {
    expect(html).toContain('Descreva o que você quer construir');
  });
});

describe('P1 UI — Sidebar / Multi-Project', () => {
  const html = prototypeUiHtml();

  it('has projects list', () => {
    expect(html).toContain('projectsList');
    expect(html).toContain('project-item');
  });

  it('has new project button', () => {
    expect(html).toContain('id="newProject"');
    expect(html).toContain('Novo');
  });

  it('has new project modal', () => {
    expect(html).toContain('newProjectModal');
    expect(html).toContain('newProjectName');
    expect(html).toContain('confirmNewProject');
  });

  it('has collapse sidebar button', () => {
    expect(html).toContain('collapseSidebar');
  });
});

describe('P1 UI — Error Cards', () => {
  const html = prototypeUiHtml();

  it('has error card structure', () => {
    expect(html).toContain('error-card');
    expect(html).toContain('error-card-title');
    expect(html).toContain('error-card-desc');
  });

  it('has error card action button', () => {
    expect(html).toContain('error-card-action');
  });

  it('has expandable error details', () => {
    expect(html).toContain('error-card-details');
  });
});

describe('P1 UI — Timeline', () => {
  const html = prototypeUiHtml();

  it('has timeline structure', () => {
    expect(html).toContain('timeline-step');
  });

  it('has files changed section', () => {
    expect(html).toContain('files-changed');
    expect(html).toContain('files-changed-file');
  });
});

describe('P1 UI — Mobile', () => {
  const html = prototypeUiHtml();

  it('has mobile preview button', () => {
    expect(html).toContain('mobilePreviewShowBtn');
  });

  it('has mobile back button', () => {
    expect(html).toContain('mobileBackBtn');
  });

  it('has mobile view CSS class', () => {
    expect(html).toContain('mobile-view');
    expect(html).toContain('preview-mode');
  });
});

describe('P1 UI — Design Tokens', () => {
  const html = prototypeUiHtml();

  it('uses Inter font', () => {
    expect(html).toContain('Inter');
  });

  it('uses JetBrains Mono for code', () => {
    expect(html).toContain('JetBrains Mono');
  });

  it('has dark color scheme', () => {
    expect(html).toContain('color-scheme:dark');
  });

  it('has CSS custom properties for design tokens', () => {
    expect(html).toContain('--bg-base');
    expect(html).toContain('--text-primary');
    expect(html).toContain('--accent');
    expect(html).toContain('--success');
    expect(html).toContain('--danger');
  });
});

describe('P1 UI — Safety Gate & Runtime Integrity', () => {
  it('contains valid executable JavaScript with ZERO SyntaxErrors across ALL inline scripts', async () => {
    const { prototypeUiHtml } = await import('../src/pp/ui/ui.js');
    const html = prototypeUiHtml();
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    const scripts: string[] = [];
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      if (match[1].trim()) scripts.push(match[1]);
    }
    expect(scripts.length).toBeGreaterThan(0);
    
    const vm = await import('node:vm');
    for (let i = 0; i < scripts.length; i++) {
      expect(() => {
        new vm.Script(scripts[i], { filename: `inline-script-${i}.js` });
      }).not.toThrow();
    }
  });

  it('proves the V8 parser rejects invalid JavaScript (Negative Control Test)', async () => {
    const vm = await import('node:vm');
    expect(() => {
      new vm.Script('const invalidAssignment = ;');
    }).toThrow(SyntaxError);

    expect(() => {
      new vm.Script('let loadSessionAt = 0; let loadSessionAt = 2000;');
    }).toThrow(SyntaxError);

    expect(() => {
      new vm.Script('str.replace(/(<li class="md-li">[sS]*?</li>)/gm, "");');
    }).toThrow(SyntaxError);
  });

  it('guarantees unique declaration of loadSessionAt in the generated HTML', async () => {
    const { prototypeUiHtml } = await import('../src/pp/ui/ui.js');
    const html = prototypeUiHtml();
    
    // Check let declarations containing loadSessionAt
    const letDeclarations = html.match(/\blet\s+[^;]*\bloadSessionAt\b[^;]*;/g) || [];
    expect(letDeclarations.length).toBe(1);

    // Ensure there are no separate duplicate "let loadSessionAt" or "const loadSessionAt"
    const standaloneDecl = html.match(/\b(let|const)\s+loadSessionAt\s*=/g) || [];
    expect(standaloneDecl.length).toBe(0);
  });

  it('executes in simulated browser DOM, fetches /prototype/sessions and renders projects', async () => {
    const { prototypeUiHtml } = await import('../src/pp/ui/ui.js');
    const html = prototypeUiHtml();
    const { JSDOM } = await import('jsdom');

    let fetchCalled = false;
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: 'https://pub-dev-loop-api.contato-pubcore.workers.dev/prototype',
      beforeParse(window) {
        window.localStorage = {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {}
        };
        window.EventSource = function() {
          this.close = () => {};
          this.addEventListener = () => {};
        };
        window.fetch = async (url: string) => {
          if (url === '/prototype/sessions' || url.startsWith('/prototype/sessions')) {
            fetchCalled = true;
            return {
              ok: true,
              status: 200,
              json: async () => [
                {
                  id: 'session-safety-pato',
                  project: 'sistema pato de minas',
                  status: 'READY',
                  updatedAt: new Date().toISOString(),
                }
              ]
            };
          }
          return { ok: false, status: 404 };
        };
      }
    });

    const win = dom.window;
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const list = win.document.querySelector('#projectsList');
        if (list && list.children.length > 0) {
          resolve(true);
        } else if (Date.now() - start > 3000) {
          reject(new Error('DOM render timeout for projectsList'));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    const list = win.document.querySelector('#projectsList');
    expect(fetchCalled).toBe(true);
    expect(list?.children.length).toBe(1);
    expect(list?.children[0].textContent).toContain('sistema pato de minas');
  });
});

