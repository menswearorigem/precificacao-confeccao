import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer, QrCode } from 'lucide-react';
import { api } from '../api/client';
import { Skeleton } from '../components/ui';
import QrCodigo, { urlDoLote } from '../components/QrCodigo';
import { formatQtd, dataBr } from '../lib/format';
import { compararTamanhosCliente } from './loteComum';
import './Lote.css';

// Produção › Ficha do lote (28/09/2026).
//
// O papel que acompanha o lote até a facção: o que foi, em que grade, até
// quando — e um QR code. Na volta, quem recebe aponta o celular para o QR e
// cai direto na tela de retorno daquela O.S. (/producao/lote/:id).
//
// Embaixo, uma etiqueta por cor para recortar e prender no amarrado, cada uma
// com o mesmo QR: qualquer amarrado que voltar primeiro abre o lote certo.

export default function FichaLotePage() {
  const { id } = useParams();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    api.get(`/producao-movimentacao/ordens-servico/${id}`).then(setDados).catch((e) => setErro(e.message));
  }, [id]);

  const matriz = useMemo(() => {
    const itens = dados?.itens || [];
    const cores = [...new Set(itens.map((i) => i.cor))];
    const tamanhos = [...new Set(itens.map((i) => i.tamanho))].sort(compararTamanhosCliente);
    const q = (cor, t) => itens.filter((i) => i.cor === cor && i.tamanho === t).reduce((s, i) => s + Number(i.quantidade_remetida || 0), 0);
    return { cores, tamanhos, q };
  }, [dados]);

  if (!dados) return <div className="pagina">{erro ? <p className="erro-inline">{erro}</p> : <Skeleton height={400} />}</div>;

  const os = dados.ordem_servico;
  const url = urlDoLote(os.ordem_servico_id);
  const totalCor = (cor) => matriz.tamanhos.reduce((s, t) => s + matriz.q(cor, t), 0);
  const total = matriz.cores.reduce((s, c) => s + totalCor(c), 0);

  return (
    <div className="pagina lt-ficha">
      <div className="lt-barra no-print">
        <Link to="/producao/ordens-servico" className="co-voltar"><ArrowLeft size={14} /> Ordens de serviço</Link>
        <span style={{ flex: 1 }} />
        <Link to={`/producao/lote/${os.ordem_servico_id}`} className="btn btn-ghost"><QrCode size={15} /> Abrir o retorno</Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={15} /> Imprimir ficha</button>
      </div>

      <section className="lt-folha">
        <div className="lt-cabecalho">
          <div className="lt-info">
            <span className="lt-rot">Ficha do lote</span>
            <h1>O.S. {os.numero} · {os.fornecedor_nome}</h1>
            <dl>
              <div><dt>Etapa</dt><dd>{os.etapa_nome}</dd></div>
              <div><dt>OP</dt><dd>{os.ordem_numero}</dd></div>
              <div><dt>Referência</dt><dd><b>{os.produto_referencia}</b> {os.produto_descricao}</dd></div>
              <div><dt>Saiu em</dt><dd>{os.data_remessa ? dataBr(os.data_remessa) : '—'}</dd></div>
              <div><dt>Volta até</dt><dd><b>{os.previsao_retorno ? dataBr(os.previsao_retorno) : 'sem prazo'}</b></dd></div>
              <div><dt>Peças</dt><dd><b>{formatQtd(total)}</b></dd></div>
            </dl>
          </div>
          <div className="lt-qr">
            <QrCodigo texto={url} tamanho={170} />
            <small>Na volta, aponte a câmera do celular aqui para registrar o retorno.</small>
          </div>
        </div>

        <table className="lt-grade">
          <thead>
            <tr><th>Cor</th>{matriz.tamanhos.map((t) => <th key={t}>{t}</th>)}<th>Total</th><th className="lt-anotar">Voltou</th></tr>
          </thead>
          <tbody>
            {matriz.cores.map((cor) => (
              <tr key={cor}>
                <td><b>{cor || 'sem cor'}</b></td>
                {matriz.tamanhos.map((t) => <td key={t}>{matriz.q(cor, t) || '·'}</td>)}
                <td><b>{formatQtd(totalCor(cor))}</b></td>
                <td className="lt-anotar" />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              {matriz.tamanhos.map((t) => <td key={t}>{formatQtd(matriz.cores.reduce((s, c) => s + matriz.q(c, t), 0))}</td>)}
              <td><b>{formatQtd(total)}</b></td>
              <td className="lt-anotar" />
            </tr>
          </tfoot>
        </table>

        <div className="lt-assinaturas">
          <span>Conferido na saída: ______________________</span>
          <span>Conferido na volta: ______________________</span>
        </div>

        <div className="lt-recorte-rot">✂ Etiquetas para os amarrados — recorte na linha</div>
        <div className="lt-etiquetas">
          {matriz.cores.map((cor) => (
            <div key={cor} className="lt-etiqueta">
              <QrCodigo texto={url} tamanho={84} />
              <div>
                <b>O.S. {os.numero} · {os.produto_referencia}</b>
                <span className="lt-etq-cor">{cor || 'sem cor'}</span>
                <span>{matriz.tamanhos.filter((t) => matriz.q(cor, t) > 0).map((t) => `${t} ${matriz.q(cor, t)}`).join(' · ')}</span>
                <small>{os.fornecedor_nome} · {formatQtd(totalCor(cor))} pç</small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
