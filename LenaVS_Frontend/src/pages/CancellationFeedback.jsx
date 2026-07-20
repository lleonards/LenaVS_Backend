import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { XCircle, Loader2, CheckCircle2 } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const CANCELLATION_REASONS = [
  { value: 'not_found', label: 'Não encontrei o que precisava' },
  { value: 'difficult_to_use', label: 'A plataforma é difícil de usar' },
  { value: 'alternative_tool', label: 'Encontrei outra ferramenta' },
  { value: 'technical_issues', label: 'Problemas técnicos' },
  { value: 'price', label: 'Preço' },
  { value: 'no_longer_use', label: 'Não utilizo mais a plataforma' },
  { value: 'other', label: 'Outro' },
];

const REASON_PROMPTS = {
  not_found: 'O que você estava procurando e não encontrou?',
  difficult_to_use: 'Como podemos melhorar sua experiência?',
  technical_issues: 'Quais problemas você encontrou?',
  price: 'O que tornaria o plano mais interessante para você?',
  other: 'Conte-nos mais',
};

const CancellationFeedback = () => {
  const navigate = useNavigate();
  const { refreshCredits } = useAuth();
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    refreshCredits?.();
  }, []);

  const feedbackPrompt = REASON_PROMPTS[reason] || '';
  const showFeedbackField = Boolean(feedbackPrompt);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!reason) {
      setError('Selecione um motivo para continuar.');
      return;
    }

    try {
      setSubmitting(true);
      setError('');
      await api.post('/user/cancellation-feedback', { reason, feedback });
      setSubmitted(true);
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.message ||
        'Não foi possível enviar o feedback agora.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    navigate('/editor');
  };

  const handleGoToEditor = () => {
    navigate('/editor');
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #0e0e0e, #050505)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: 'Montserrat, sans-serif',
    }}>
      <div style={{
        width: 'min(560px, 100%)',
        background: '#141414',
        border: '1px solid rgba(255,140,90,0.18)',
        borderRadius: 24,
        boxShadow: '0 30px 90px rgba(0,0,0,0.45)',
        padding: '30px',
        color: '#fff',
      }}>
        {submitted ? (
          <>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: 20,
              background: 'rgba(74,222,128,0.12)',
              color: '#4ade80',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
            }}>
              <CheckCircle2 size={30} />
            </div>

            <h1 style={{ margin: '0 0 10px', fontSize: '26px', fontWeight: 800 }}>
              Obrigado pelo feedback!
            </h1>
            <p style={{ margin: '0 0 24px', color: '#cfcfcf', lineHeight: 1.7 }}>
              Sua opinião é muito importante para continuarmos melhorando a LenaVS.
              Esperamos te ver de volta em breve.
            </p>

            <button
              type="button"
              onClick={handleGoToEditor}
              style={{
                background: '#ff8c5a',
                color: '#111',
                padding: '12px 22px',
                borderRadius: 12,
                fontWeight: 800,
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              Voltar para o editor
            </button>
          </>
        ) : (
          <>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: 20,
              background: 'rgba(239,68,68,0.12)',
              color: '#f87171',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
            }}>
              <XCircle size={30} />
            </div>

            <h1 style={{ margin: '0 0 8px', fontSize: '26px', fontWeight: 800 }}>
              Assinatura cancelada
            </h1>
            <p style={{ margin: '0 0 24px', color: '#cfcfcf', lineHeight: 1.7 }}>
              Sentimos muito pela sua saída. Antes de voltar ao editor, conte-nos o motivo do cancelamento — seu feedback nos ajuda a melhorar a LenaVS.
            </p>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 20 }}>
                <strong style={{ display: 'block', marginBottom: 12, color: '#e0e0e0', fontSize: '14px' }}>
                  Por que você cancelou sua assinatura?
                </strong>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {CANCELLATION_REASONS.map((option) => {
                    const isSelected = reason === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setReason(option.value);
                          setFeedback('');
                          setError('');
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '12px 14px',
                          borderRadius: 10,
                          border: isSelected
                            ? '1.5px solid #ff8c5a'
                            : '1.5px solid rgba(255,255,255,0.1)',
                          background: isSelected
                            ? 'rgba(255,140,90,0.08)'
                            : 'rgba(255,255,255,0.03)',
                          color: isSelected ? '#ff8c5a' : '#d0d0d0',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: '14px',
                          fontWeight: isSelected ? 700 : 400,
                          transition: 'all 0.15s',
                        }}
                      >
                        <span style={{
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          border: isSelected ? '5px solid #ff8c5a' : '2px solid rgba(255,255,255,0.3)',
                          flexShrink: 0,
                          transition: 'all 0.15s',
                        }} />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {showFeedbackField ? (
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, color: '#d0d0d0', fontSize: '13px' }}>
                    {feedbackPrompt}
                  </label>
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Escreva aqui (opcional)"
                    maxLength={1200}
                    rows={4}
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: 10,
                      border: '1.5px solid rgba(255,255,255,0.12)',
                      background: 'rgba(255,255,255,0.04)',
                      color: '#fff',
                      fontSize: '14px',
                      lineHeight: 1.6,
                      resize: 'vertical',
                      boxSizing: 'border-box',
                      fontFamily: 'Montserrat, sans-serif',
                    }}
                  />
                </div>
              ) : null}

              {error ? (
                <div style={{
                  marginBottom: 16,
                  padding: '12px 14px',
                  borderRadius: 10,
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  color: '#ffb3b3',
                  fontSize: '13px',
                }}>
                  {error}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="submit"
                  disabled={submitting || !reason}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: reason ? '#ff8c5a' : 'rgba(255,140,90,0.3)',
                    color: '#111',
                    padding: '12px 20px',
                    borderRadius: 12,
                    fontWeight: 800,
                    border: 'none',
                    cursor: reason && !submitting ? 'pointer' : 'not-allowed',
                    fontSize: '14px',
                    opacity: submitting ? 0.75 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                      Enviando...
                    </>
                  ) : (
                    'Enviar feedback'
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={submitting}
                  style={{
                    background: 'transparent',
                    color: '#888',
                    padding: '12px 18px',
                    borderRadius: 12,
                    border: '1px solid rgba(255,255,255,0.1)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  Pular
                </button>
              </div>
            </form>
          </>
        )}

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
};

export default CancellationFeedback;
