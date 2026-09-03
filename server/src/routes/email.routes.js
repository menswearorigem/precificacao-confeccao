// Diagnóstico do envio de e-mail. Só administrador.
//
// Existe porque a recuperação de senha depende de um serviço externo (SMTP) e,
// até a varredura de 03/09/2026, não havia jeito nenhum de saber se ele estava
// de pé — o sistema dizia "enviamos o e-mail" mesmo sem SMTP configurado, e a
// falha só aparecia no log do servidor, que ninguém lê.

const express = require('express');
const { verificarSmtp, enviarEmail, moldar, configurado, remetente } = require('../lib/mailer');
const { registrar } = require('../lib/auditoria');

const router = express.Router();

// Conecta no servidor de e-mail e volta dizendo se deu certo — sem mandar
// mensagem nenhuma.
router.get('/status', async (req, res, next) => {
  try {
    res.json(await verificarSmtp());
  } catch (err) {
    next(err);
  }
});

// Manda um e-mail de teste de verdade, pro endereço que o administrador
// escolher (por padrão, o dele mesmo). É a prova final de que a recuperação
// de senha vai funcionar quando alguém precisar.
router.post('/teste', async (req, res, next) => {
  try {
    const destino = String((req.body && req.body.para) || req.user.email || '').trim();
    if (!destino || !destino.includes('@')) {
      return res.status(400).json({ error: 'Informe um e-mail de destino válido.' });
    }
    if (!configurado()) {
      return res.status(400).json({
        error:
          'SMTP não está configurado no servidor. Defina SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e SMTP_FROM em Render → Environment e reinicie o serviço.',
      });
    }

    const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const resultado = await enviarEmail({
      para: destino,
      assunto: 'HBN Hub — teste de envio de e-mail',
      texto:
        `Este é um e-mail de teste do HBN Hub.\n\n` +
        `Se você recebeu isto, a recuperação de senha e o lembrete de usuário estão funcionando.\n\n` +
        `Disparado por: ${req.user.nome}\nData: ${quando}\nRemetente: ${remetente()}`,
      html: moldar({
        titulo: 'Teste de envio de e-mail',
        corpoHtml:
          `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Se você está lendo isto, o envio de e-mail do HBN Hub está funcionando — e portanto a <strong>recuperação de senha</strong> e o <strong>lembrete de nome de usuário</strong> também.</p>` +
          `<p style="margin:0;font-size:13px;line-height:1.8;color:#6b5f56;">Disparado por: <strong>${req.user.nome}</strong><br>Data: ${quando}<br>Remetente configurado: ${remetente()}</p>`,
        rodape: 'Mensagem de teste enviada manualmente pela tela de Acessos › Histórico do HBN Hub.',
      }),
    });

    await registrar(req, {
      acao: 'testou',
      entidade: 'email',
      descricao: resultado.enviado
        ? `Enviou um e-mail de teste para ${destino}.`
        : `Tentou enviar um e-mail de teste para ${destino} e falhou: ${resultado.motivo}`,
      sucesso: resultado.enviado,
    });

    if (!resultado.enviado) {
      return res.status(502).json({ error: `O servidor de e-mail recusou o envio: ${resultado.motivo}` });
    }
    res.json({ ok: true, mensagem: `E-mail de teste enviado para ${destino}. Confira a caixa de entrada (e o spam).` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
