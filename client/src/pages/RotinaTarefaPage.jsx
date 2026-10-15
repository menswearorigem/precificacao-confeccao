import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import RotinaTarefa from '../components/RotinaTarefa';
import '../styles/rotinas.css';

// Rotinas › uma tarefa (15/10/2026). Tela cheia da execução — é o que abre
// ao tocar numa linha do Meu dia, no Início ou no sino.
export default function RotinaTarefaPage() {
  const { id } = useParams();
  const { user } = useAuth();
  return (
    <div className="page rotinas rt-pagina-tarefa">
      <div className="rt-voltar-linha">
        <Link to="/rotinas" className="rt-voltar"><ArrowLeft size={15} />Meu dia</Link>
        {user?.role === 'admin' && <Link to="/rotinas/equipe" className="rt-voltar">Equipe</Link>}
      </div>
      <RotinaTarefa key={id} id={id} />
    </div>
  );
}
