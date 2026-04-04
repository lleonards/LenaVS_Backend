import { supabase } from '../config/supabase.js';
import { normalizeProjectPayload } from '../utils/stanzaNormalizer.js';

const DEFAULT_RESOLUTION = '720p';

const normalizeIncomingConfig = (body = {}) => {
  const rawConfig =
    body.config ??
    body.data ??
    {};

  return normalizeProjectPayload(rawConfig);
};

const normalizeProjectResponse = (project) => {
  if (!project) return project;

  return {
    ...project,
    config: normalizeProjectPayload(project.config || {}),
  };
};

export const createProject = async (req, res) => {
  try {
    const { name, resolution, description, isPublic, forkedFrom } = req.body;
    const userId = req.user.id;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Nome do projeto é obrigatório' });
    }

    const payload = {
      user_id: userId,
      name: String(name).trim(),
      config: normalizeIncomingConfig(req.body),
      resolution: String(resolution || DEFAULT_RESOLUTION),
      description: String(description || '').trim(),
      is_public: typeof isPublic === 'boolean' ? isPublic : true,
      forked_from: forkedFrom || null,
    };

    const { data: project, error } = await supabase
      .from('projects')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      project: normalizeProjectResponse(project),
    });
  } catch (error) {
    console.error('Erro ao criar projeto:', error);
    return res.status(500).json({ error: 'Erro ao criar projeto' });
  }
};

export const listProjects = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: projects, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      projects: (projects || []).map(normalizeProjectResponse),
    });
  } catch (error) {
    console.error('Erro ao listar projetos:', error);
    return res.status(500).json({ error: 'Erro ao listar projetos' });
  }
};

export const listPublicProjects = async (req, res) => {
  try {
    const userId = req.user.id;
    const search = String(req.query.q || '').trim();

    let query = supabase
      .from('projects')
      .select('id, user_id, name, description, resolution, is_public, download_count, forked_from, created_at, updated_at, config')
      .eq('is_public', true)
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    }

    const { data: projects, error } = await query;

    if (error) throw error;

    const otherUserIds = [...new Set((projects || []).map((item) => item.user_id).filter(Boolean))];
    let ownerMap = {};

    if (otherUserIds.length) {
      const { data: owners, error: ownersError } = await supabase
        .from('users')
        .select('id, email')
        .in('id', otherUserIds);

      if (ownersError) {
        console.warn('Não foi possível carregar autores dos projetos públicos:', ownersError.message);
      } else {
        ownerMap = Object.fromEntries((owners || []).map((owner) => [owner.id, owner.email]));
      }
    }

    const normalizedProjects = (projects || []).map((project) => ({
      ...normalizeProjectResponse(project),
      owner_email: ownerMap[project.user_id] || null,
      is_owner: project.user_id === userId,
    }));

    return res.status(200).json({
      success: true,
      projects: normalizedProjects,
    });
  } catch (error) {
    console.error('Erro ao listar biblioteca pública:', error);
    return res.status(500).json({ error: 'Erro ao listar biblioteca pública' });
  }
};

export const getProject = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: project, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const canAccess = project.user_id === userId || project.is_public === true;

    if (!canAccess) {
      return res.status(403).json({ error: 'Você não tem permissão para acessar este projeto' });
    }

    return res.status(200).json({
      success: true,
      project: normalizeProjectResponse(project),
    });
  } catch (error) {
    console.error('Erro ao obter projeto:', error);
    return res.status(500).json({ error: 'Erro ao obter projeto' });
  }
};

export const updateProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, resolution, description, isPublic } = req.body;
    const userId = req.user.id;

    const { data: existingProject, error: existingError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (existingError) throw existingError;

    if (!existingProject) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const updateData = {};

    if (typeof name !== 'undefined') {
      if (!String(name).trim()) {
        return res.status(400).json({ error: 'Nome do projeto é obrigatório' });
      }
      updateData.name = String(name).trim();
    }

    if (typeof req.body.config !== 'undefined' || typeof req.body.data !== 'undefined') {
      updateData.config = normalizeIncomingConfig(req.body);
    }

    if (typeof resolution !== 'undefined') {
      updateData.resolution = String(resolution || DEFAULT_RESOLUTION);
    }

    if (typeof description !== 'undefined') {
      updateData.description = String(description || '').trim();
    }

    if (typeof isPublic === 'boolean') {
      updateData.is_public = isPublic;
    }

    const { data: project, error } = await supabase
      .from('projects')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      project: normalizeProjectResponse(project),
    });
  } catch (error) {
    console.error('Erro ao atualizar projeto:', error);
    return res.status(500).json({ error: 'Erro ao atualizar projeto' });
  }
};

export const toggleProjectPublicStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: existingProject, error: existingError } = await supabase
      .from('projects')
      .select('id, user_id, is_public')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (existingError) throw existingError;

    if (!existingProject) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const nextIsPublic = !existingProject.is_public;

    const { data: project, error } = await supabase
      .from('projects')
      .update({ is_public: nextIsPublic })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      project: normalizeProjectResponse(project),
      isPublic: nextIsPublic,
    });
  } catch (error) {
    console.error('Erro ao alternar publicação do projeto:', error);
    return res.status(500).json({ error: 'Erro ao alternar publicação do projeto' });
  }
};

export const forkProject = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const requestedName = String(req.body?.name || '').trim();

    const { data: originalProject, error: originalError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (originalError) throw originalError;

    if (!originalProject) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    if (!originalProject.is_public && originalProject.user_id !== userId) {
      return res.status(403).json({ error: 'Este projeto não está disponível para cópia' });
    }

    const forkName = requestedName || `${originalProject.name} (cópia)`;

    const { data: forkedProject, error: forkError } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        name: forkName,
        config: normalizeProjectPayload(originalProject.config || {}),
        resolution: originalProject.resolution || DEFAULT_RESOLUTION,
        description: originalProject.description || '',
        is_public: false,
        forked_from: originalProject.id,
      })
      .select('*')
      .single();

    if (forkError) throw forkError;

    if (originalProject.user_id !== userId) {
      const { error: downloadHistoryError } = await supabase
        .from('project_downloads')
        .insert({
          project_id: originalProject.id,
          user_id: userId,
        });

      if (downloadHistoryError) {
        console.warn('Não foi possível registrar o fork no histórico:', downloadHistoryError.message);
      }

      const { error: incrementError } = await supabase.rpc('increment_download_count', {
        project_id: originalProject.id,
      });

      if (incrementError) {
        console.warn('Não foi possível incrementar download_count:', incrementError.message);
      }
    }

    return res.status(201).json({
      success: true,
      project: normalizeProjectResponse(forkedProject),
    });
  } catch (error) {
    console.error('Erro ao criar cópia do projeto:', error);
    return res.status(500).json({ error: 'Erro ao criar cópia do projeto' });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: 'Projeto deletado com sucesso',
    });
  } catch (error) {
    console.error('Erro ao deletar projeto:', error);
    return res.status(500).json({ error: 'Erro ao deletar projeto' });
  }
};
