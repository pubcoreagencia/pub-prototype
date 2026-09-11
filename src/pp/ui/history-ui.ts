export function prototypeHistoryUiScript(): string {
  return `<script>
(() => {
  const root = document.querySelector('.meta');
  if (!root) return;
  let state = { sessionId: localStorage.getItem('pub-prototype:last-session'), checkpoints: [], comparisonId: null };
  const panel = document.createElement('div');
  panel.id = 'pp-history';
  panel.innerHTML = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #27272a"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa"><span>Version History</span><span id="pp-version-count"></span></div><div id="pp-version-list"></div><pre id="pp-diff" style="display:none;max-height:260px;overflow:auto;margin-top:8px;padding:10px;border:1px solid #27272a;border-radius:9px;background:#09090b;color:#d4d4d8;font-size:10px;white-space:pre-wrap"></pre></div>';
  root.appendChild(panel);
  const list = panel.querySelector('#pp-version-list');
  const count = panel.querySelector('#pp-version-count');
  const diff = panel.querySelector('#pp-diff');

  const modal = document.createElement('div');
  modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;padding:24px';
  modal.innerHTML = '<div style="height:100%;max-width:1600px;margin:auto;background:#111113;border:1px solid #3f3f46;border-radius:14px;display:flex;flex-direction:column;overflow:hidden"><div style="height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid #27272a;color:#e4e4e7"><strong>Preview comparison</strong><button id="pp-compare-close" style="border:1px solid #3f3f46;background:#18181b;color:#d4d4d8;border-radius:8px;padding:7px 10px;cursor:pointer">Fechar</button></div><div id="pp-compare-status" style="padding:8px 16px;color:#a1a1aa;font-size:11px">Preparando preview…</div><div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;background:#09090b"><div style="display:flex;flex-direction:column;min-width:0"><div style="padding:7px 9px;color:#a1a1aa;font-size:11px;text-transform:uppercase">Versão selecionada</div><iframe id="pp-compare-version" style="width:100%;height:100%;border:1px solid #27272a;border-radius:10px;background:#fff"></iframe></div><div style="display:flex;flex-direction:column;min-width:0"><div style="padding:7px 9px;color:#a1a1aa;font-size:11px;text-transform:uppercase">Versão atual</div><iframe id="pp-compare-current" style="width:100%;height:100%;border:1px solid #27272a;border-radius:10px;background:#fff"></iframe></div></div></div>';
  document.body.appendChild(modal);
  const compareStatus = modal.querySelector('#pp-compare-status');
  const versionFrame = modal.querySelector('#pp-compare-version');
  const currentFrame = modal.querySelector('#pp-compare-current');
  modal.querySelector('#pp-compare-close').addEventListener('click', async () => {
    if (state.comparisonId && state.sessionId) {
      await fetch('/prototype/sessions/'+encodeURIComponent(state.sessionId)+'/comparison-previews/'+encodeURIComponent(state.comparisonId), { method: 'DELETE' }).catch(() => undefined);
      state.comparisonId = null;
    }
    modal.style.display = 'none';
    versionFrame.src = 'about:blank';
  });

  const render = () => {
    count.textContent = state.checkpoints.length;
    if (!state.checkpoints.length) { list.innerHTML = '<span style="font-size:11px;color:#71717a">Nenhum checkpoint ainda.</span>'; return; }
    list.innerHTML = state.checkpoints.slice().sort((a,b) => b.promptIndex-a.promptIndex).map(cp =>
      '<div style="display:flex;align-items:center;gap:7px;padding:8px 9px;margin-bottom:6px;border:1px solid #27272a;background:#151517;border-radius:9px"><div style="min-width:0;flex:1"><div style="font-size:12px;color:#e4e4e7">v'+cp.promptIndex+' · '+String(cp.prompt).slice(0,42).replace(/[&<>]/g,'')+'</div><div style="font-size:10px;color:#71717a;margin-top:2px">'+(cp.commitSha?cp.commitSha.slice(0,8):'sem commit')+'</div></div><button data-preview="'+cp.id+'" style="border:1px solid #3f3f46;background:#18181b;color:#d4d4d8;border-radius:7px;padding:5px 7px;font-size:10px;cursor:pointer">Preview</button><button data-diff="'+cp.id+'" style="border:1px solid #3f3f46;background:#18181b;color:#d4d4d8;border-radius:7px;padding:5px 7px;font-size:10px;cursor:pointer">Diff</button><button data-restore="'+cp.id+'" style="border:1px solid #3f3f46;background:#18181b;color:#d4d4d8;border-radius:7px;padding:5px 7px;font-size:10px;cursor:pointer" '+(cp.commitSha?'':'disabled')+'>Restaurar</button></div>'
    ).join('');
  };
  const sync = async () => {
    if (!state.sessionId) return;
    const r = await fetch('/prototype/sessions/'+encodeURIComponent(state.sessionId));
    if (!r.ok) return;
    const data = await r.json(); state.checkpoints = data.checkpoints || []; render();
  };
  const showDiff = async id => {
    const sorted = state.checkpoints.slice().sort((a,b)=>a.promptIndex-b.promptIndex);
    const idx = sorted.findIndex(x=>x.id===id);
    if (idx < 1) { diff.style.display='block'; diff.textContent='A primeira versão não possui uma versão anterior para comparação.'; return; }
    const from=sorted[idx-1], to=sorted[idx];
    const r=await fetch('/prototype/sessions/'+encodeURIComponent(state.sessionId)+'/diff?from='+encodeURIComponent(from.id)+'&to='+encodeURIComponent(to.id));
    const data=await r.json(); diff.style.display='block'; diff.textContent=data.diff||'(sem diferenças)';
  };
  const showPreview = async id => {
    const cp=state.checkpoints.find(x=>x.id===id); if(!cp||!cp.commitSha||!state.sessionId) return;
    modal.style.display='block'; compareStatus.textContent='Subindo preview de v'+cp.promptIndex+'…';
    const currentSrc = document.querySelector('iframe[title="PUB Prototype live preview"]')?.src;
    if(currentSrc && currentSrc !== 'about:blank') currentFrame.src = currentSrc;
    const r=await fetch('/prototype/sessions/'+encodeURIComponent(state.sessionId)+'/comparison-previews',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({checkpointId:id})});
    if(!r.ok){compareStatus.textContent='Falha ao criar preview comparativo.';return;}
    const data=await r.json(); state.comparisonId=data.id; versionFrame.src=data.info?.url||'about:blank'; compareStatus.textContent='v'+cp.promptIndex+' aberta ao lado da versão atual.';
  };
  const restore = async id => {
    const cp=state.checkpoints.find(x=>x.id===id); if(!cp) return;
    if(!confirm('Restaurar a v'+cp.promptIndex+'? O histórico será preservado e uma nova versão será criada.')) return;
    const r=await fetch('/prototype/sessions/'+encodeURIComponent(state.sessionId)+'/restore/'+encodeURIComponent(id),{method:'POST'});
    if(!r.ok){alert('Falha ao restaurar a versão.');return;} await sync();
  };
  list.addEventListener('click',e=>{const p=e.target.closest('[data-preview]');if(p)showPreview(p.dataset.preview);const d=e.target.closest('[data-diff]');if(d)showDiff(d.dataset.diff);const r=e.target.closest('[data-restore]');if(r)restore(r.dataset.restore);});
  window.addEventListener('pp:session',e=>{state.sessionId=e.detail?.id||state.sessionId;sync();});
  if (state.sessionId) sync();
  window.addEventListener('storage', e => { if (e.key==='pub-prototype:last-session') { state.sessionId=e.newValue; sync(); } });
})();
</script>`;
}
