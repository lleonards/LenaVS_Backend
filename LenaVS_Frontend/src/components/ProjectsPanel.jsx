import React, { useMemo } from 'react';
import {
  BookOpen,
  Clock3,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import './ProjectsPanel.css';

const UNKNOWN_PRODUCTION_NAME = 'não identificado';

const formatDateTime = (value) => {
  if (!value) return 'Data indisponível';

  try {
    return new Date(value).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_) {
    return value;
  }
};

const getProductionName = (project) => {
  const name = String(project?.owner_name || '').trim();
  return name || UNKNOWN_PRODUCTION_NAME;
};

const BusyLabel = ({ isBusy, text, fallbackIcon, fallbackText }) => {
  if (isBusy) {
    return (
      <>
        <Loader2 size={15} className="projects-spinner" />
        {text}
      </>
    );
  }

  return (
    <>
      {fallbackIcon}
      {fallbackText}
    </>
  );
};

const ProjectsPanel = ({
  isOpen,
  activeTab,
  onTabChange,
  myProjects,
  libraryProjects,
  librarySearch,
  onLibrarySearchChange,
  loadingMyProjects,
  loadingLibrary,
  onRefreshMyProjects,
  onRefreshLibrary,
  onOpenProject,
  onTogglePublic,
  onDeleteProject,
  onForkProject,
  onCreateNewProject,
  onClose,
  loadingProjectId,
  loadingProjectAction,
}) => {
  const filteredLibraryProjects = useMemo(() => {
    const term = librarySearch.trim().toLowerCase();
    if (!term) return libraryProjects;

    return libraryProjects.filter((project) => {
      const name = String(project.name || '').toLowerCase();
      const description = String(project.description || '').toLowerCase();
      const production = getProductionName(project).toLowerCase();
      return name.includes(term) || description.includes(term) || production.includes(term);
    });
  }, [libraryProjects, librarySearch]);

  const isProjectBusy = (projectId, action) => (
    loadingProjectId === projectId && loadingProjectAction === action
  );

  const isAnyProjectBusy = Boolean(loadingProjectId);

  if (!isOpen) return null;

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel" onClick={(event) => event.stopPropagation()}>
        <div className="projects-panel__header">
          <div>
            <h3>Projetos</h3>
            <p>Gerencie o histórico dos seus projetos e explore a biblioteca pública.</p>
          </div>

          <div className="projects-panel__header-actions">
            <button type="button" className="projects-secondary-btn" onClick={onCreateNewProject} disabled={isAnyProjectBusy}>
              <Plus size={15} />
              Novo projeto
            </button>
            <button type="button" className="projects-close-btn" onClick={onClose} disabled={isAnyProjectBusy}>
              Fechar
            </button>
          </div>
        </div>

        <div className="projects-tabs">
          <button
            type="button"
            className={`projects-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => onTabChange('history')}
            disabled={isAnyProjectBusy}
          >
            <Clock3 size={16} />
            Histórico
          </button>

          <button
            type="button"
            className={`projects-tab ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => onTabChange('library')}
            disabled={isAnyProjectBusy}
          >
            <BookOpen size={16} />
            Biblioteca
          </button>
        </div>

        {activeTab === 'history' ? (
          <div className="projects-section">
            <div className="projects-section__toolbar">
              <span>Nome do projeto, data/hora de criação e controle de publicação.</span>
              <button type="button" className="projects-icon-btn" onClick={onRefreshMyProjects} disabled={loadingMyProjects || isAnyProjectBusy}>
                <RefreshCw size={15} /> Atualizar
              </button>
            </div>

            <div className="projects-list">
              {loadingMyProjects ? (
                <div className="projects-empty">Carregando histórico...</div>
              ) : myProjects.length ? (
                myProjects.map((project) => (
                  <div key={project.id} className="project-card">
                    <div className="project-card__main">
                      <div className="project-card__title-row">
                        <strong>{project.name}</strong>
                        <span className={`project-status ${project.is_public ? 'public' : 'private'}`}>
                          {project.is_public ? 'Público' : 'Privado'}
                        </span>
                      </div>

                      <div className="project-card__meta">
                        <span>Criado em: {formatDateTime(project.created_at)}</span>
                        {project.resolution ? <span>Resolução: {project.resolution}</span> : null}
                      </div>
                    </div>

                    <div className="project-card__actions">
                      <button
                        type="button"
                        className="projects-primary-btn"
                        onClick={() => onOpenProject(project)}
                        disabled={isAnyProjectBusy}
                      >
                        <BusyLabel
                          isBusy={isProjectBusy(project.id, 'open')}
                          text="Abrindo..."
                          fallbackIcon={<FolderOpen size={15} />}
                          fallbackText="Abrir"
                        />
                      </button>

                      <button
                        type="button"
                        className="projects-toggle-btn"
                        onClick={() => onTogglePublic(project)}
                        disabled={isAnyProjectBusy}
                      >
                        <BusyLabel
                          isBusy={isProjectBusy(project.id, 'toggle-public')}
                          text="Salvando..."
                          fallbackIcon={project.is_public ? <EyeOff size={15} /> : <Eye size={15} />}
                          fallbackText={project.is_public ? 'Despublicar' : 'Publicar'}
                        />
                      </button>

                      <button
                        type="button"
                        className="projects-danger-btn"
                        onClick={() => onDeleteProject(project)}
                        disabled={isAnyProjectBusy}
                      >
                        <BusyLabel
                          isBusy={isProjectBusy(project.id, 'delete')}
                          text="Excluindo..."
                          fallbackIcon={<Trash2 size={15} />}
                          fallbackText="Excluir"
                        />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="projects-empty">
                  Você ainda não tem projetos salvos. Use o painel de exportação para criar o primeiro.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="projects-section">
            <div className="projects-section__toolbar projects-section__toolbar--library">
              <div className="projects-search">
                <Search size={16} />
                <input
                  type="text"
                  value={librarySearch}
                  onChange={(event) => onLibrarySearchChange(event.target.value)}
                  placeholder="Pesquisar projetos disponíveis"
                  disabled={isAnyProjectBusy}
                />
              </div>

              <button type="button" className="projects-icon-btn" onClick={onRefreshLibrary} disabled={loadingLibrary || isAnyProjectBusy}>
                <RefreshCw size={15} /> Atualizar
              </button>
            </div>

            <div className="projects-list">
              {loadingLibrary ? (
                <div className="projects-empty">Carregando biblioteca...</div>
              ) : filteredLibraryProjects.length ? (
                filteredLibraryProjects.map((project) => (
                  <div key={project.id} className="project-card">
                    <div className="project-card__main">
                      <div className="project-card__title-row">
                        <strong>{project.name}</strong>
                        <span className="project-status public">Disponível</span>
                      </div>

                      <div className="project-card__meta">
                        <span>Criado em: {formatDateTime(project.created_at)}</span>
                        <span>Produção: {getProductionName(project)}</span>
                      </div>

                      {project.description ? (
                        <p className="project-card__description">{project.description}</p>
                      ) : (
                        <p className="project-card__description muted">
                          Projeto público pronto para ser reutilizado e personalizado.
                        </p>
                      )}
                    </div>

                    <div className="project-card__actions">
                      <button
                        type="button"
                        className="projects-primary-btn"
                        onClick={() => onForkProject(project)}
                        disabled={isAnyProjectBusy}
                      >
                        <BusyLabel
                          isBusy={isProjectBusy(project.id, 'fork')}
                          text="Carregando..."
                          fallbackIcon={<Pencil size={15} />}
                          fallbackText="Editar cópia"
                        />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="projects-empty">
                  Nenhum projeto público encontrado para essa pesquisa.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectsPanel;
