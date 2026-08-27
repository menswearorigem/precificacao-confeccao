import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, Save } from 'lucide-react';
import { api } from '../api/client';
import { Field } from './ui';
import { formatQtd } from '../lib/format';

function hoje(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}

export default function WikIntegracaoCard() {
  const [integracao, setIntegracao] = useState(null);
  const [marcas, setMarcas] = useState([]);
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(true);
  const [testando, setTestando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState(null);
  const [sincronizandoAgora, setSincronizandoAgora] = useState(false);

  const [testandoCompleto, setTestandoCompleto] = useState(false);
  const [resultadoTesteCompleto, setResultadoTesteCompleto] = useState(null);

  function load() {
    setLoading(true);
    Promise.all([api.get('/wik'), api.get('/listas/marca')]).then(([wikData, marcasData]) => {
      setIntegracao(wikData);
      setEmail(wikData?.email || '');
      setMarcas(marcasData);
      setLoading(false);
      if (wikData?.previewStatus === 'rodando') {
        setPreviewLoading(true);
        esperarPreview();
      }
    });
  }

  useEffect(load, []);

  async function salvarCredencial(e) {
    e.preventDefault();
    setErro('');
    setSalvando(true);
    try {
      await api.post('/wik', { email, senha });
      setSenha('');
      setAviso('Credencial salva.');
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function testarConexao() {
    setErro('');
    setAviso('');
    setTestando(true);
    try {
      const resultado = await api.post('/wik/testar', {});
      // Propositalmente NÃO diz "token válido" aqui — testar conexão só faz
      // login, não prova que uma chamada de dado de verdade (estoque etc.)
      // funciona, e o selo abaixo já reserva essa frase pro resultado da
      // última chamada de dado (ver comentário em wik.routes.js).
      setAviso(`Login no Wik funcionou agora como ${resultado.nome} (${resultado.email}), expira ${hoje(resultado.expiraEm)}. Isso não garante que a próxima sincronização de dados vá funcionar.`);
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setTestando(false);
    }
  }

  // "Testar conexão completa" (item 7) — o equivalente na tela do teste
  // feito direto na API por PowerShell fora do sistema: login isolado +
  // 1 chamada de saldo_estoque_get + 1 de tamanhos_get, mostrando status
  // HTTP, body.status e corpo bruto de cada uma. Não mexe no status normal
  // da integração (não roda job nenhum junto).
  async function testarConexaoCompleta() {
    setErro('');
    setAviso('');
    setResultadoTesteCompleto(null);
    setTestandoCompleto(true);
    try {
      const resultado = await api.post('/wik/testar-completo', {});
      setResultadoTesteCompleto(resultado);
    } catch (err) {
      setErro(err.message);
    } finally {
      setTestandoCompleto(false);
    }
  }

  async function alterarEmpId(marca, valor) {
    const wikEmpId = valor ? Number(valor) : null;
    const atualizado = await api.put(`/listas/marca/${marca.id}`, { wik_emp_id: wikEmpId });
    setMarcas((lista) => lista.map((m) => (m.id === marca.id ? atualizado : m)));
  }

  // Puxar o saldo inteiro do Wik pode levar minutos (o Wik só deixa 3
  // requisições/segundo) — tempo demais pra uma única chamada aguardar.
  // O botão só dispara o job em segundo plano e essa função fica
  // perguntando o status de tempos em tempos até ele terminar.
  async function previsualizarEstoque() {
    setErro('');
    setAviso('');
    setResultadoSync(null);
    setPreview(null);
    setPreviewLoading(true);
    try {
      await api.post('/wik/estoque/preview', {});
      await esperarPreview();
    } catch (err) {
      setErro(err.message);
      setPreviewLoading(false);
    }
  }

  async function esperarPreview() {
    for (let tentativa = 0; tentativa < 200; tentativa += 1) {
      const status = await api.get('/wik/estoque/preview');
      if (status.status === 'concluido') {
        setPreview(status.resultado);
        setPreviewLoading(false);
        return;
      }
      if (status.status === 'erro') {
        setErro(status.erro || 'Falha ao buscar o estoque no Wik.');
        setPreviewLoading(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    setErro('A busca no Wik está demorando demais — tente de novo em alguns minutos.');
    setPreviewLoading(false);
  }

  // Força a sincronização completa (busca + aplica) agora, sem esperar o
  // próximo ciclo automático — mesma rotina que já roda sozinha a cada 15min.
  async function sincronizarAgora() {
    setErro('');
    setAviso('');
    setResultadoSync(null);
    setSincronizandoAgora(true);
    try {
      const data = await api.post('/wik/estoque/sincronizar-agora', {});
      if (data.pulado) {
        setAviso(`Não rodou agora: ${data.pulado}.`);
      } else {
        setResultadoSync(data);
      }
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSincronizandoAgora(false);
    }
  }

  async function confirmarSincronizacao() {
    if (!preview) return;
    setConfirmando(true);
    setErro('');
    try {
      const data = await api.post('/wik/estoque/confirmar', { criar: preview.criar, atualizar: preview.atualizar });
      setResultadoSync(data);
      setPreview(null);
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setConfirmando(false);
    }
  }

  if (loading) return null;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Wik Sistemas (ERP) — Sincronização de Estoque</div>
      <p className="page-sub" style={{ marginTop: -6, marginBottom: 14 }}>
        Puxa o saldo de estoque direto da API do Wik pras referências já cadastradas aqui, atualizando
        sozinho a cada 15 minutos — sem precisar clicar em nada. Os botões abaixo são só pra
        conferir/forçar uma sincronização na hora, se precisar.
      </p>

      <form onSubmit={salvarCredencial} className="form-grid" style={{ marginBottom: 10 }}>
        <Field label="Email (login do Wik)">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@dominio.com" />
        </Field>
        <Field label="Senha">
          <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder={integracao ? '•••••• (deixe em branco pra manter)' : ''} />
        </Field>
      </form>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn btn-primary" onClick={salvarCredencial} disabled={salvando || !email}>
          <Save size={13} /> {salvando ? 'Salvando…' : 'Salvar credencial'}
        </button>
        {integracao && (
          <button className="btn btn-ghost" onClick={testarConexao} disabled={testando}>
            <RefreshCw size={13} /> {testando ? 'Testando…' : 'Testar conexão'}
          </button>
        )}
        {integracao && (
          <button className="btn btn-ghost" onClick={testarConexaoCompleta} disabled={testandoCompleto}>
            <RefreshCw size={13} /> {testandoCompleto ? 'Testando…' : 'Testar conexão completa'}
          </button>
        )}
      </div>

      {resultadoTesteCompleto && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-head">Resultado do teste completo (login → estoque → tamanhos)</div>
          <p className="page-sub" style={{ marginTop: -6 }}>
            Login: criação {hoje(resultadoTesteCompleto.login.criacao)}, expira {hoje(resultadoTesteCompleto.login.expiracao)}
            {resultadoTesteCompleto.login.expiracaoSuspeita && ' (o Wik não trouxe uma expiração clara desta vez)'}.
            Usuário master: {String(resultadoTesteCompleto.login.usuarioMaster ?? 'não informado')}.
            Empresas com acesso: {String(resultadoTesteCompleto.login.empresaAcesso ?? 'não informado')}.
          </p>
          <table className="data-table">
            <thead><tr><th>Chamada</th><th>Base</th><th>HTTP</th><th>body.status</th><th>Corpo bruto</th></tr></thead>
            <tbody>
              <tr>
                <td>saldo_estoque_get</td>
                <td className="mono">{resultadoTesteCompleto.saldoEstoque.base}</td>
                <td>{resultadoTesteCompleto.saldoEstoque.pulado ? '—' : resultadoTesteCompleto.saldoEstoque.httpStatus}</td>
                <td>{resultadoTesteCompleto.saldoEstoque.pulado ? '—' : String(resultadoTesteCompleto.saldoEstoque.bodyStatus)}</td>
                <td className="mono" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
                  {resultadoTesteCompleto.saldoEstoque.pulado || JSON.stringify(resultadoTesteCompleto.saldoEstoque.corpo)}
                </td>
              </tr>
              <tr>
                <td>tamanhos_get</td>
                <td className="mono">{resultadoTesteCompleto.tamanhos.base}</td>
                <td>{resultadoTesteCompleto.tamanhos.httpStatus}</td>
                <td>{String(resultadoTesteCompleto.tamanhos.bodyStatus)}</td>
                <td className="mono" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
                  {JSON.stringify(resultadoTesteCompleto.tamanhos.corpo)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {integracao && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          {integracao.statusToken === 'valido' && (
            <span className="stamp sm tone-saudavel"><CheckCircle2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Token válido</span>
          )}
          {integracao.statusToken === 'rejeitado' && (
            <span className="stamp sm tone-prejuizo"><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Token rejeitado pelo Wik</span>
          )}
          {integracao.statusToken === 'erro_outro' && (
            <span className="stamp sm tone-atencao"><AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Última tentativa falhou</span>
          )}
          {integracao.statusToken === 'nao_testado' && (
            <span className="stamp sm tone-neutro">Ainda não testado</span>
          )}
          <span className="page-sub" style={{ margin: 0, fontWeight: integracao.statusToken === 'rejeitado' ? 700 : undefined }}>
            Último saldo sincronizado: {hoje(integracao.ultimaSincronizacao)}
          </span>
          <span className="page-sub" style={{ margin: 0 }}>Última tentativa: {hoje(integracao.ultimaTentativa)}</span>
        </div>
      )}

      {integracao?.statusToken === 'rejeitado' && (
        <div className="login-error" style={{ marginBottom: 12 }}>
          O Wik está recusando o token da API desde a última sincronização bem-sucedida (acima). O login continua
          funcionando normalmente — só as chamadas de dado (estoque, produtos, ficha de custo) são rejeitadas.
          Teste direto na API (fora do sistema, 27/08/2026) confirmou que isso NÃO é sessão duplicada: o mesmo erro
          acontece com um login isolado, sem ninguém mais usando a credencial. É o acesso de dados da conta que
          está revogado ou suspenso do lado do Wik — não tem conserto daqui; verifique com o suporte deles.
          {integracao.rejeicoesConsecutivasToken >= 5 && (
            <> Já são {integracao.rejeicoesConsecutivasToken} rejeições seguidas — reduzimos o ritmo das tentativas
            automáticas (1x por hora) até normalizar.</>
          )}
        </div>
      )}
      {integracao?.rejeicoesToken24h >= 3 && integracao.statusToken !== 'rejeitado' && (
        <div className="login-error" style={{ marginBottom: 12 }}>
          O Wik rejeitou o token {integracao.rejeicoesToken24h}x nas últimas 24h. Considere um usuário exclusivo de
          API no Wik, usado só por esta integração — facilita auditar/ajustar as permissões dela sem afetar o
          acesso de uma pessoa de verdade.
        </div>
      )}
      {integracao?.ultimaExpiracaoSuspeita && (
        <div className="login-error" style={{ marginBottom: 12 }}>
          O último login não trouxe uma data de expiração que desse pra entender ({hoje(integracao.ultimaExpiracaoSuspeita)}) —
          tratamos o token como já expirado nesse caso (sem chutar nenhum prazo), então ele deve renovar sozinho na
          próxima chamada.
        </div>
      )}

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="stamp sm tone-saudavel" style={{ marginBottom: 12, display: 'inline-flex' }}>{aviso}</div>}
      {integracao?.ultimoErro && !erro && (
        <div className="login-error" style={{ marginBottom: 12 }}>Última tentativa falhou: {integracao.ultimoErro}</div>
      )}

      <div className="card-head" style={{ marginTop: 4 }}>Id da Empresa por marca</div>
      <table className="data-table" style={{ marginBottom: 14 }}>
        <thead><tr><th>Marca</th><th>Id da Empresa no Wik</th></tr></thead>
        <tbody>
          {marcas.map((m) => (
            <tr key={m.id}>
              <td>{m.valor}</td>
              <td>
                <input
                  className="mono" style={{ maxWidth: 120 }} type="number"
                  defaultValue={m.wik_emp_id || ''}
                  placeholder="não configurado"
                  onBlur={(e) => alterarEmpId(m, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={sincronizarAgora} disabled={sincronizandoAgora || previewLoading || !integracao}>
          <RefreshCw size={13} /> {sincronizandoAgora ? 'Sincronizando…' : 'Sincronizar agora'}
        </button>
        <button className="btn btn-ghost" onClick={previsualizarEstoque} disabled={previewLoading || sincronizandoAgora || !integracao}>
          <RefreshCw size={13} /> {previewLoading ? 'Buscando no Wik…' : 'Só conferir (sem aplicar)'}
        </button>
        {(previewLoading || sincronizandoAgora) && (
          <span className="page-sub" style={{ margin: 0 }}>
            O Wik só libera 3 requisições por segundo — com estoque grande isso pode levar alguns minutos.
          </span>
        )}
      </div>

      {resultadoSync && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--success-ring)' }}>
          <div className="card-head" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Sincronização concluída
          </div>
          <p>{resultadoSync.criados} variante(s) nova(s), {resultadoSync.atualizados} atualizada(s).</p>
        </div>
      )}

      {preview && (
        <>
          <p className="page-sub">
            {preview.resumo.totalLinhasWik} linha(s) recebida(s) do Wik. {preview.resumo.variantesCriar} nova(s),{' '}
            {preview.resumo.variantesAtualizar} com mudança de saldo, {preview.resumo.totalErros} com erro.
            Nada foi gravado ainda.
          </p>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head">Variantes novas ({preview.criar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd.</th></tr></thead>
                <tbody>
                  {preview.criar.slice(0, 100).map((v, i) => (
                    <tr key={i}><td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td><td className="mono">{formatQtd(v.quantidadeNova)}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.criar.length > 100 && <p className="page-sub">Mostrando 100 de {preview.criar.length}.</p>}
            </div>
            <div className="card">
              <div className="card-head">Variantes a atualizar ({preview.atualizar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd. atual</th><th>Qtd. nova</th></tr></thead>
                <tbody>
                  {preview.atualizar.slice(0, 100).map((v, i) => (
                    <tr key={i}>
                      <td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td>
                      <td className="mono">{formatQtd(v.quantidadeAtual)}</td>
                      <td className="mono" style={{ fontWeight: 700 }}>{formatQtd(v.quantidadeNova)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.atualizar.length > 100 && <p className="page-sub">Mostrando 100 de {preview.atualizar.length}.</p>}
            </div>
          </div>

          {preview.erros.length > 0 && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger-ring)' }}>
              <div className="card-head" style={{ color: 'var(--danger)' }}>
                <AlertTriangle size={14} /> Linhas com erro ({preview.erros.length}) — não serão sincronizadas
              </div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Motivo</th></tr></thead>
                <tbody>
                  {preview.erros.slice(0, 100).map((e, i) => (
                    <tr key={i}><td className="mono">{e.dados.referencia}</td><td>{e.dados.cor}</td><td>{e.dados.tamanho}</td><td>{e.motivo}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="btn btn-primary" onClick={confirmarSincronizacao} disabled={confirmando}>
            {confirmando ? 'Gravando…' : 'Confirmar sincronização'}
          </button>
        </>
      )}
    </div>
  );
}
