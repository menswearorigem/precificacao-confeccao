// Relatório de Vendas — Vendas › Resultado › Relatório de Vendas.
//
// 02/10/2026: o relatório apresentado aos diretores, dentro do Hub.
// 05/10/2026 (manhã): passa a se alimentar sozinho (lib/relatorioVendas.js no
//   servidor junta a exportação do Wik com os pedidos que o ciclo puxa).
// 05/10/2026 (tarde): visual repaginado a partir do modelo que o dono aprovou,
//   e a tela passa a ser SÓ o relatório, de ponta a ponta — a faixa de status
//   que ficava em cima foi para dentro do próprio relatório (selos no topo e a
//   janela "Como os números são montados", com a conferência).
//
// Como funciona:
//   - o modelo (relatorio/relatorioVendas.html) entra no pacote como texto;
//   - os dados vêm de /api/vendas/relatorio/dados (login + módulo Vendas);
//   - o modelo roda num iframe srcdoc. O script dele é liberado na CSP pelo
//     hash (middleware/seguranca.js); o iframe segue o tema do Hub;
//   - o relatório fala com esta tela por postMessage: "atualizar" (monta de
//     novo no servidor), "json" (mostra um arquivo do Wik só nesta tela, sem
//     gravar) e "voltar" (volta aos dados do sistema). O nível aberto (#/g/0…)
//     é preservado quando o documento é remontado.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import modelo from '../relatorio/relatorioVendas.html?raw';
import { api } from '../api/client';
import { AvisoDeFalha, Skeleton } from '../components/ui';

const CHAVES = ['months', 'canais', 'grupos', 'subs', 'marcas', 'refs', 'f', 'cores', 'c', 'tams', 't', 'o'];

function validar(d) {
  if (!d || typeof d !== 'object') return 'o arquivo não é um JSON de objeto.';
  const faltando = CHAVES.filter((k) => !Array.isArray(d[k]));
  if (faltando.length) return `faltam no arquivo: ${faltando.join(', ')}.`;
  if (!d.f.length) return 'o arquivo não tem nenhuma linha de venda (f).';
  const r = d.f[0];
  if (!Array.isArray(r) || r.length < 6) return 'as linhas de venda (f) não estão no formato [ref, mês, canal, peças, faturamento, custo].';
  return null;
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function montarDocumento(dados, { local = '', hash = '' } = {}) {
  // `<` e `>` escapados: o JSON vai dentro de <script>, e um "</script>" numa
  // descrição de produto fecharia a tag.
  const json = JSON.stringify(dados).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const extras = ` data-embed=""${local ? ` data-local="${attr(local)}"` : ''}${hash ? ` data-hash="${attr(hash)}"` : ''}`;
  return modelo
    .replace('<html lang="pt-BR">', () => `<html lang="pt-BR"${extras}>`)
    .replace('<script id="dados" type="application/json">__DATA__</script>', () => `<script id="dados" type="application/json">${json}</script>`);
}

export default function RelatorioVendasPage() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [arquivoLocal, setArquivoLocal] = useState(null); // { nome, dados }
  const [altura, setAltura] = useState(640);
  const refCaixa = useRef(null);
  const refFrame = useRef(null);
  const refHash = useRef('');

  const carregar = useCallback((forcar = false) => {
    setErro('');
    if (!forcar) setDados(null);
    api.get(`/vendas/relatorio/dados${forcar ? '?atualizar=1' : ''}`)
      .then((d) => {
        const problema = validar(d);
        if (problema) throw new Error(`Os dados vieram fora do formato: ${problema}`);
        setDados(d);
      })
      .catch((e) => setErro(e?.message || String(e)));
  }, []);

  useEffect(() => { carregar(false); }, [carregar]);

  // O relatório tem topo, filtros fixos e folhas que sobem do rodapé (no
  // celular), então o iframe ocupa exatamente a área visível que sobra até o
  // fim da janela (ou até a barra de baixo do celular) — sem margem nenhuma.
  const ajustar = useCallback(() => {
    const el = refCaixa.current;
    if (!el) return;
    const topo = el.getBoundingClientRect().top;
    let fundo = window.innerHeight;
    const barra = document.querySelector('.barra-inferior');
    if (barra) {
      const r = barra.getBoundingClientRect();
      if (r.height > 0 && r.top < fundo) fundo = r.top;
    }
    setAltura(Math.max(420, Math.round(fundo - topo)));
  }, []);

  useEffect(() => {
    ajustar();
    window.addEventListener('resize', ajustar);
    return () => window.removeEventListener('resize', ajustar);
  }, [ajustar, dados, arquivoLocal]);

  // Pedidos que chegam de dentro do relatório.
  useEffect(() => {
    function responder(msg) {
      try { refFrame.current?.contentWindow?.postMessage({ hbnRelVendasResposta: true, ...msg }, '*'); } catch { /* sem iframe */ }
    }
    function aoMensagem(ev) {
      const m = ev.data;
      if (!m || !m.hbnRelVendas || ev.source !== refFrame.current?.contentWindow) return;
      if (typeof m.hash === 'string' && /^#\/([gsr]\/\d+)?$/.test(m.hash)) refHash.current = m.hash;
      if (m.acao === 'atualizar') carregar(true);
      else if (m.acao === 'voltar') setArquivoLocal(null);
      else if (m.acao === 'json') {
        try {
          const d = JSON.parse(String(m.texto || ''));
          const problema = validar(d);
          if (problema) { responder({ erro: `Esse arquivo não serve: ${problema}` }); return; }
          setArquivoLocal({ nome: String(m.nome || 'arquivo.json').slice(0, 80), dados: d });
        } catch {
          responder({ erro: 'Esse arquivo não é um JSON válido.' });
        }
      }
    }
    window.addEventListener('message', aoMensagem);
    return () => window.removeEventListener('message', aoMensagem);
  }, [carregar]);

  const ativo = arquivoLocal ? arquivoLocal.dados : dados;
  // Montar o documento custa (o JSON tem ~500 KB): só refaz quando o dado muda.
  // O nível aberto entra junto (data-hash) para a remontagem não voltar ao Geral.
  const documento = useMemo(
    () => (ativo ? montarDocumento(ativo, { local: arquivoLocal ? arquivoLocal.nome : '', hash: refHash.current }) : ''),
    [ativo, arquivoLocal],
  );

  return (
    <div className="relvendas-tela" ref={refCaixa} style={{ height: altura }}>
      <style>{`
        .relvendas-tela { width: 100%; margin: 0; padding: 0; position: relative; overflow: hidden; }
        .relvendas-tela iframe { display: block; width: 100%; height: 100%; border: 0; }
        .relvendas-esqueleto { padding: 28px 32px; display: grid; gap: 14px; }
        .relvendas-erro { padding: 24px 32px; }
      `}</style>
      {ativo ? (
        <iframe
          ref={refFrame}
          // `key` troca o documento inteiro quando a fonte muda.
          key={arquivoLocal ? `local:${arquivoLocal.nome}` : `sistema:${ativo.auto?.montadoEm || ativo.geradoEm}`}
          title="Relatório de Vendas"
          srcDoc={documento}
        />
      ) : erro ? (
        <div className="relvendas-erro"><AvisoDeFalha mensagem={erro} aoTentarDeNovo={() => carregar(false)} /></div>
      ) : (
        <div className="relvendas-esqueleto">
          <Skeleton width="100%" height={150} radius={12} />
          <Skeleton width="60%" height={34} />
          <Skeleton width="100%" height={110} radius={12} />
          <Skeleton width="100%" height={280} radius={12} />
        </div>
      )}
      {ativo && erro && (
        <div style={{ position: 'absolute', left: 16, right: 16, top: 12, zIndex: 5 }}>
          <AvisoDeFalha mensagem={erro} aoTentarDeNovo={() => carregar(true)} />
        </div>
      )}
    </div>
  );
}
