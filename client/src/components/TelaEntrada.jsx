import logoHbnHub from '../assets/logo-hbn-hub.png';

// Casca visual comum às telas de acesso (login, esqueci senha, redefinir
// senha) — o selo com a logo, o nome do sistema e o rodapé de marcas.
// Cada tela só entra com o próprio cartão como children.
export default function TelaEntrada({ children }) {
  return (
    <div className="login-screen">
      <div className="login-seal-wrap">
        <div className="login-seal">
          <img src={logoHbnHub} alt="Marca HBN Hub" />
        </div>
        <div className="login-eyebrow">Sistema de Gestão Têxtil</div>
        <h1 className="login-wordmark">HBN <em>Hub</em></h1>
      </div>

      {children}

      <div className="login-brands">
        <span>Miss Manu</span>
        <span>Origem</span>
        <span>Hoggar</span>
        <span>Hebron</span>
      </div>
    </div>
  );
}
