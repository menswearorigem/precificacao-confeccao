import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/theme.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Service worker: só em produção e só depois que a página terminou de
// carregar. Duas razões, nessa ordem:
//   1. Em desenvolvimento ele atrapalha de verdade — o Vite serve os módulos
//      sem hash e troca arquivo a quente; um service worker no meio devolve
//      versão velha e a pessoa fica caçando um bug que não existe.
//   2. Registrar antes do 'load' disputa banda com o próprio carregamento da
//      tela, o que deixa a primeira abertura mais lenta justamente pra quem
//      está no 4G do galpão.
// Falha no registro é engolida de propósito: sem service worker o sistema
// funciona igual, só não abre offline. Nunca é motivo pra quebrar a tela.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
