// Relatório de Vendas (02/10/2026) — Vendas › Resultado › Relatório de Vendas.
//
// A tela é o mesmo relatório que foi apresentado aos diretores (arquivo HTML
// único), agora dentro do Hub: abre no Geral, afunila Grupo › Subgrupo ›
// Referência, tem filtros de período e canal, Destaques e comentários
// editáveis, impressão e "Salvar versão editada".
//
// Como funciona:
//   - o modelo (relatorio/relatorioVendas.html) entra no pacote como texto;
//   - os dados vêm de /api/vendas/relatorio/dados (exige login + módulo Vendas;
//     o arquivo não fica na pasta pública);
//   - o modelo recebe o JSON e roda num iframe (srcdoc), isolado do CSS do Hub,
//     seguindo o tema claro/escuro do Hub;
//   - os textos editados ficam guardados neste navegador; "Salvar versão
//     editada" baixa o arquivo avulso com eles gravados dentro.
//
// O botão "Abrir outro JSON do Wik" mostra um arquivo novo SÓ nesta tela, sem
// gravar no sistema — serve para conferir uma exportação antes de trocar o
// arquivo do servidor (server/src/data/relatorio-vendas.json).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import modelo from '../relatorio/relatorioVendas.html?raw';
import { api } from '../api/client';
import { AvisoDeFalha, Skeleton } from '../components/ui';

const CHAVES = ['months', 'canais', 'grupos', 'subs', 'marcas', 'refs', 'f', 'cores', 'c', 'tams', 't', 'o'];
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function validar(d) {
  if (!d || typeof d !== 'object') return 'O arquivo não é um JSON de objeto.';
  const faltando = CHAVES.filter((k) => !Array.isArray(d[k]));
  if (faltando.length) return `Faltam no arquivo: ${faltando.join(', ')}.`;
  if (!d.f.length) return 'O arquivo não tem nenhuma linha de venda (f).';
  const r = d.f[0];
  if (!Array.isArray(r) || r.length < 6) return 'As linhas de venda (f) não estão no formato [ref, mês, canal, peças, faturamento, custo].';
  return null;
}

function mesCurto(ym) {
  const [a, m] = String(ym || '').split('-');
  return a && m ? `${MES[Number(m) - 1]}/${a.slice(2)}` : '—';
}

function dataBr(s) {
  const p = String(s || '').split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '—';
}

function montarDocumento(dados) {
  // `<` e `>` escapados: o JSON vai dentro de <script>, e um "</script>" numa
  // descrição de produto fecharia a tag.
  const json = JSON.stringify(dados).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return modelo
    .replace('<html lang="pt-BR">', '<html lang="pt-BR" data-embed="">')
    .replace('<script type="application/json" id="data">__DATA__</script>', () => `<script type="application/json" id="data">${json}</script>`);
}

export default function RelatorioVendasPage() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [arquivoLocal, setArquivoLocal] = useState(null); // { nome, dados }
  const [avisoArquivo, setAvisoArquivo] = useState('');
  const [altura, setAltura] = useState(640);
  const refCaixa = useRef(null);
  const refInput = useRef(null);

  const carregar = useCallback(() => {
    setErro('');
    setDados(null);
    api.get('/vendas/relatorio/dados')
      .then((d) => {
        const problema = validar(d);
        if (problema) throw new Error(problema);
        setDados(d);
      })
      .catch((e) => setErro(e?.message || String(e)));
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  // O relatório tem cabeçalho fixo e folhas que sobem do rodapé (no celular),
  // então o iframe ocupa a área visível que sobra, e não a altura do conteúdo.
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
    setAltura(Math.max(460, Math.round(fundo - topo - 12)));
  }, []);

  useEffect(() => {
    ajustar();
    window.addEventListener('resize', ajustar);
    return () => window.removeEventListener('resize', ajustar);
  }, [ajustar, dados, arquivoLocal]);

  function abrirArquivo(ev) {
    const arq = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!arq) return;
    setAvisoArquivo('');
    const leitor = new FileReader();
    leitor.onload = () => {
      try {
        const d = JSON.parse(String(leitor.result));
        const problema = validar(d);
        if (problema) { setAvisoArquivo(`Esse arquivo não serve: ${problema}`); return; }
        setArquivoLocal({ nome: arq.name, dados: d });
      } catch {
        setAvisoArquivo('Esse arquivo não é um JSON válido.');
      }
    };
    leitor.readAsText(arq, 'utf-8');
  }

  const ativo = arquivoLocal ? arquivoLocal.dados : dados;
  // Montar o documento custa (o JSON tem ~500 KB): só refaz quando o dado muda.
  const documento = useMemo(() => (ativo ? montarDocumento(ativo) : ''), [ativo]);
  const periodo = ativo?.months?.length
    ? `${mesCurto(ativo.months[0])} – ${mesCurto(ativo.months[ativo.months.length - 1])}`
    : '';

  return (
    <div className="page-wide relvendas">
      <style>{`
        .relvendas-barra { display:flex; align-items:center; justify-content:space-between; gap:10px 16px; flex-wrap:wrap; margin: 0 0 10px; }
        .relvendas-info { font-size: 13px; color: var(--ink-soft); line-height: 1.4; }
        .relvendas-info b { color: var(--ink); }
        .relvendas-local { color: var(--terracotta); font-weight: 600; }
        .relvendas-acoes { display:flex; gap:8px; flex-wrap:wrap; }
        .relvendas-quadro { width: 100%; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow-sm, 0 1px 3px rgba(66,42,21,.08)); }
        .relvendas-quadro iframe { display:block; width:100%; border:0; }
        .relvendas-esqueleto { padding: 24px; display:grid; gap:14px; }
        .relvendas-curto { display: none; }
        @media (max-width: 759.98px) {
          .relvendas-barra { margin-bottom: 8px; flex-wrap: nowrap; }
          .relvendas-info { font-size: 12px; min-width: 0; }
          .relvendas-longo { display: none; }
          .relvendas-curto { display: inline; }
          .relvendas-acoes { flex: none; }
          .relvendas-acoes .btn { min-height: 44px; padding: 0 12px; font-size: 13px; }
          .relvendas-quadro { border-radius: 10px; }
        }
      `}</style>

      <div className="relvendas-barra">
        <div className="relvendas-info">
          {ativo ? (
            arquivoLocal ? (
              <>
                <span className="relvendas-local">Mostrando o arquivo “{arquivoLocal.nome}” só nesta tela</span>
                {' '}— não fica salvo no sistema · <b>{periodo}</b>
              </>
            ) : (
              <>
                Dados do Wik · <b>{periodo}</b>
                <span className="relvendas-longo"> · exportados em {dataBr(ativo.geradoEm)} · só operações de VENDA</span>
              </>
            )
          ) : 'Carregando os dados de venda…'}
        </div>
        <div className="relvendas-acoes">
          {arquivoLocal && (
            <button type="button" className="btn btn-ghost" onClick={() => { setArquivoLocal(null); setAvisoArquivo(''); }}>
              <span className="relvendas-longo">Voltar aos dados do sistema</span>
              <span className="relvendas-curto">Voltar</span>
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => refInput.current && refInput.current.click()}>
            <span className="relvendas-longo">Abrir outro JSON do Wik</span>
            <span className="relvendas-curto">Outro JSON</span>
          </button>
          <input ref={refInput} type="file" accept="application/json,.json" hidden onChange={abrirArquivo} />
        </div>
      </div>

      {avisoArquivo && (
        <div className="login-error" role="alert" style={{ marginBottom: 10 }}>{avisoArquivo}</div>
      )}
      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={carregar} />

      <div className="relvendas-quadro" ref={refCaixa}>
        {ativo ? (
          <iframe
            // `key` troca o documento inteiro quando o arquivo muda.
            key={arquivoLocal ? `local:${arquivoLocal.nome}` : `sistema:${ativo.geradoEm}`}
            title="Relatório de Vendas"
            srcDoc={documento}
            style={{ height: altura }}
          />
        ) : !erro ? (
          <div className="relvendas-esqueleto" style={{ height: altura }}>
            <Skeleton width="40%" height={28} />
            <Skeleton width="100%" height={90} radius={12} />
            <Skeleton width="100%" height={260} radius={12} />
            <Skeleton width="100%" height={220} radius={12} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
