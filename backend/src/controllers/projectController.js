import { supabase } from '../config/supabase.js';

/* ================================================
   CRIAR PROJETO
================================================ */
export const createProject = async (req, res) => {
  try {
    const { name, data, is_public = false, resolution = '720p', description = '' } = req.body;
    const userId = req.user.id;

    if (!name) return res.status(400).json({ error: 'Nome do projeto é obrigatório' });

    const { data: project, error } = await supabase
      .from('projects')
      .insert([{
        user_id:     userId,
        name,
        config:      data || {},
        is_public,
        resolution,
        description,
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      }])
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, project });
  } catch (error) {
    console.error('Erro ao criar projeto:', error);
    return res.status(500).json({ error: 'Erro ao criar projeto' });
  }
};

/* ================================================
   LISTAR PROJETOS DO USUÁRIO (histórico)
================================================ */
export const listProjects = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: projects, error } = await supabase
      .from('projects')
      .select('id, name, config, is_public, resolution, description, download_count, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({ success: true, projects: projects || [] });
  } catch (error) {
    console.error('Erro ao listar projetos:', error);
    return res.status(500).json({ error: 'Erro ao listar projetos' });
  }
};

/* ================================================
   LISTAR PROJETOS PÚBLICOS (biblioteca)
================================================ */
export const listPublicProjects = async (req, res) => {
  try {
    const { data: projects, error } = await supabase
      .from('projects')
      .select(`
        id, name, config, resolution, description, download_count, created_at, updated_at,
        users ( email )
      `)
      .eq('is_public', true)
      .order('download_count', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.status(200).json({ success: true, projects: projects || [] });
  } catch (error) {
    console.error('Erro ao listar projetos públicos:', error);
    return res.status(500).json({ error: 'Erro ao listar projetos públicos' });
  }
};

/* ================================================
   OBTER PROJETO ESPECÍFICO
================================================ */
export const getProject = async (req, res) => {
  try {
    const { id }   = req.params;
    const userId   = req.user.id;

    const { data: project, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .or(`user_id.eq.${userId},is_public.eq.true`)
      .single();

    if (error) throw error;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });

    return res.status(200).json({ success: true, project });
  } catch (error) {
    console.error('Erro ao obter projeto:', error);
    return res.status(500).json({ error: 'Erro ao obter projeto' });
  }
};

/* ================================================
   ATUALIZAR PROJETO
================================================ */
export const updateProject = async (req, res) => {
  try {
    const { id }   = req.params;
    const userId   = req.user.id;
    const { name, data, is_public, resolution, description } = req.body;

    const updateData = { updated_at: new Date().toISOString() };
    if (name        !== undefined) updateData.name        = name;
    if (data        !== undefined) updateData.config      = data;
    if (is_public   !== undefined) updateData.is_public   = is_public;
    if (resolution  !== undefined) updateData.resolution  = resolution;
    if (description !== undefined) updateData.description = description;

    const { data: project, error } = await supabase
      .from('projects')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({ success: true, project });
  } catch (error) {
    console.error('Erro ao atualizar projeto:', error);
    return res.status(500).json({ error: 'Erro ao atualizar projeto' });
  }
};

/* ================================================
   ALTERAR VISIBILIDADE
================================================ */
export const updateVisibility = async (req, res) => {
  try {
    const { id }       = req.params;
    const userId       = req.user.id;
    const { is_public } = req.body;

    if (typeof is_public !== 'boolean') {
      return res.status(400).json({ error: 'Campo is_public deve ser boolean' });
    }

    const { data: project, error } = await supabase
      .from('projects')
      .update({ is_public, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({ success: true, project });
  } catch (error) {
    console.error('Erro ao alterar visibilidade:', error);
    return res.status(500).json({ error: 'Erro ao alterar visibilidade' });
  }
};

/* ================================================
   FORK — cria cópia do projeto público para o user
================================================ */
export const forkProject = async (req, res) => {
  try {
    const { id }   = req.params;
    const userId   = req.user.id;

    // Busca o projeto original (deve ser público OU do próprio user)
    const { data: original, error: fetchError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .or(`user_id.eq.${userId},is_public.eq.true`)
      .single();

    if (fetchError || !original) {
      return res.status(404).json({ error: 'Projeto não encontrado ou não é público' });
    }

    // Cria cópia
    const { data: forked, error: forkError } = await supabase
      .from('projects')
      .insert([{
        user_id:      userId,
        name:         `${original.name} (cópia)`,
        config:       original.config,
        is_public:    false,
        resolution:   original.resolution,
        description:  original.description,
        forked_from:  original.id,
        created_at:   new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      }])
      .select()
      .single();

    if (forkError) throw forkError;

    // Incrementa download_count do original
    await supabase.rpc('increment_download_count', { project_id: original.id });

    return res.status(201).json({ success: true, project: forked });
  } catch (error) {
    console.error('Erro ao fazer fork:', error);
    return res.status(500).json({ error: 'Erro ao duplicar projeto' });
  }
};

/* ================================================
   DELETAR PROJETO
================================================ */
export const deleteProject = async (req, res) => {
  try {
    const { id }   = req.params;
    const userId   = req.user.id;

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    return res.status(200).json({ success: true, message: 'Projeto deletado com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar projeto:', error);
    return res.status(500).json({ error: 'Erro ao deletar projeto' });
  }
};
