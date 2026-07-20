import React from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';
import { goToAppRoute } from '../utils/appPath';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || 'Erro inesperado ao carregar a interface.',
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Erro capturado pelo ErrorBoundary:', error, errorInfo);
  }

  handleReload = () => {
    goToAppRoute('/');
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div style={{
        minHeight: '100vh',
        background: '#090909',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}>
        <div style={{
          width: 'min(520px, 100%)',
          background: '#151515',
          border: '1px solid rgba(255,140,90,0.18)',
          borderRadius: '22px',
          padding: '28px',
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
        }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: 18,
            background: 'rgba(255,140,90,0.14)',
            color: '#ff8c5a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}>
            <AlertTriangle size={28} />
          </div>

          <h1 style={{ margin: 0, fontSize: '28px', color: '#ffb08d' }}>Algo saiu do esperado</h1>
          <p style={{ margin: '12px 0 0', color: '#d2d2d2', lineHeight: 1.6 }}>
            A interface encontrou um erro inesperado. Para evitar a tela branca, o LenaVS exibiu esta página de recuperação.
          </p>
          <p style={{ margin: '8px 0 0', color: '#8f8f8f', fontSize: '14px' }}>{this.state.message}</p>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: 24 }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                background: '#ff8c5a',
                color: '#111',
                padding: '12px 18px',
                borderRadius: 12,
                fontWeight: 800,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <RefreshCcw size={16} />
              Recarregar LenaVS
            </button>

            <a
              href="mailto:noreply@lenavs.com?subject=Erro%20na%20LenaVS"
              style={{
                background: '#232323',
                color: '#fff',
                padding: '12px 18px',
                borderRadius: 12,
                fontWeight: 700,
              }}
            >
              Falar com suporte
            </a>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
