import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { supabase } from '../config/supabase.js';
import { BASE_URL, resolveUploadPathFromUrl } from '../services/videoGenerationService.js';
import { normalizeProjectPayload } from '../utils/stanzaNormalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_RESOLUTION = '720p';
const UNKNOWN_OWNER_NAME = 'não identificado';
const UPLOADS_ROOT = path.join(__dirname, '../../uploads');
const PROJECT_MEDIA_KEYS = ['musicaOriginal', 'musicaInstrumental', 'video', 'imagem'];
const VALID_AUDIO_TYPES = new Set(['original', 'instrumental']);

const normalizeIncomingConfig = (body = {}) => {
  const rawConfig = body.config ?? body.data ?? {};
  return normalizeProjectPayload(rawConfig);
};

const normalizeProjectResponse = (project) => {
  if (!project) return project;

  return {
    ...project,
    config: normalizeProjectPayload(project.config || {}),
  };
};

const extractDisplayNameFromAuthUser = (authUser) => {
  const candidates = [
    authUser?.user_metadata?.name,
    authUser?.user_metadata?.full_name,
    authUser?.user_metadata?.display_name,
    authUser?.raw_user_meta_data?.name,
    authUser?.raw_user_meta_data?.full_name,
    authUser?.raw_user_meta_data?.display_name,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const extractUploadsRelativePath = (fileUrl) => {
  const rawValue = String(fileUrl || '').trim();
  if (!rawValue) return null;

  try {
    if (isHttpUrl(rawValue)) {
      const parsed = new URL(rawValue);
      const markerIndex = parsed.pathname.indexOf('/uploads/');
      if (markerIndex === -1) return null;
      return decodeURIComponent(parsed.pathname.slice(markerIndex + '/uploads/'.length));
    }
  } catch {
    return null;
  }

  if (rawValue.startsWith('/uploads/')) {
    return decodeURIComponent(rawValue.slice('/uploads/'.length));
  }

  const markerIndex = rawValue.indexOf('/uploads/');
  if (markerIndex !== -1) {
    return decodeURIComponent(rawValue.slice(markerIndex + '/uploads/'.length).split('?')[0]);
  }

  return null;
};

const encodeRelativeUploadPath = (relativePath = '') => (
  String(relativePath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
);

const sanitizeMediaBaseName = (value = 'arquivo') => (
  String(value || 'arquivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'arquivo'
);

const ensureUserUploadsDir = async (userId) => {
  const dirPath = path.join(UPLOADS_ROOT, String(userId || 'anonymous'));
  await fs.promises.mkdir(dirPath, { recursive: true });
  return dirPath;
};

const buildUserUploadPublicUrl = (userId, fileName) => (
  `${BASE_URL}/uploads/${encodeURIComponent(String(userId))}/${encodeURIComponent(fileName)}`
);

const getDefaultExtensionForMediaKey = (mediaKey) => {
  if (mediaKey === 'video') return '.mp4';
  if (mediaKey === 'imagem') return '.jpg';
  return '.mp3';
};

const resolveLockedAudioType = (config = {}) => {
  const normalized = String(config?.lockedAudioType || config?.audioType || '').trim().toLowerCase();

  if (VALID_AUDIO_TYPES.has(normalized)) {
    return normalized;
  }

  if (config?.mediaFiles?.musicaOriginal) {
    return 'original';
  }

  if (config?.mediaFiles?.musicaInstrumental) {
    return 'instrumental';
  }

  return null;
};

const restrictMediaFilesToLockedAudioType = (mediaFiles = {}, lockedAudioType = null) => {
  const restricted = {
    musicaOriginal: null,
    musicaInstrumental: null,
    video: mediaFiles?.video || null,
    imagem: mediaFiles?.imagem || null,
  };

  if (lockedAudioType === 'instrumental') {
    restricted.musicaInstrumental = mediaFiles?.musicaInstrumental || null;
    return restricted;
  }

  if (lockedAudioType === 'original') {
    restricted.musicaOriginal = mediaFiles?.musicaOriginal || null;
    return restricted;
  }

  return {
    ...restricted,
    musicaOriginal: mediaFiles?.musicaOriginal || null,
    musicaInstrumental: mediaFiles?.musicaInstrumental || null,
  };
};

const deriveOriginalFileName = (sourceValue, mediaKey) => {
  const rawValue = String(sourceValue || '').trim();
  const fallback = `${mediaKey || 'arquivo'}${getDefaultExtensionForMediaKey(mediaKey)}`;
  if (!rawValue) return fallback;

  const localPath = resolveUploadPathFromUrl(rawValue);
  if (localPath) {
    const localBaseName = path.basename(localPath);
    if (localBaseName) return localBaseName;
  }

  try {
    if (isHttpUrl(rawValue)) {
      const parsed = new URL(rawValue);
      const remoteBaseName = path.basename(parsed.pathname);
      return remoteBaseName || fallback;
    }
  } catch {
    return fallback;
  }

  const relativeUploadPath = extractUploadsRelativePath(rawValue);
  if (relativeUploadPath) {
    return path.basename(relativeUploadPath) || fallback;
  }

  return path.basename(rawValue) || fallback;
};

const buildRemoteCandidates = (sourceValue) => {
  const rawValue = String(sourceValue || '').trim();
  const candidates = [];
  const relativeUploadPath = extractUploadsRelativePath(rawValue);

  if (relativeUploadPath) {
    candidates.push(`${BASE_URL}/uploads/${encodeRelativeUploadPath(relativeUploadPath)}`);
  }

  if (rawValue.startsWith('/uploads/')) {
    candidates.push(`${BASE_URL}${rawValue}`);
  }

  if (isHttpUrl(rawValue)) {
    candidates.push(rawValue);
  }

  return [...new Set(candidates.filter(Boolean))];
};

const downloadRemoteFile = async (url, outputPath) => {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 120000,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on('finish', () => resolve(outputPath));
    writer.on('error', reject);
  });
};

const cloneMediaFileToUserUploads = async (sourceValue, targetUserId, mediaKey) => {
  const rawValue = String(sourceValue || '').trim();
  if (!rawValue) return null;

  const uploadsDir = await ensureUserUploadsDir(targetUserId);
  const originalName = deriveOriginalFileName(rawValue, mediaKey);
  const originalExtension = path.extname(originalName || '').toLowerCase();
  const extension = originalExtension || getDefaultExtensionForMediaKey(mediaKey);
  const baseName = sanitizeMediaBaseName(path.basename(originalName, originalExtension) || mediaKey);
  const targetFileName = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
  const targetFilePath = path.join(uploadsDir, targetFileName);

  const localPath = resolveUploadPathFromUrl(rawValue);
  if (localPath && fs.existsSync(localPath)) {
    await fs.promises.copyFile(localPath, targetFilePath);
    return buildUserUploadPublicUrl(targetUserId, targetFileName);
  }

  const candidateUrls = buildRemoteCandidates(rawValue);
  let lastError = null;

  for (const candidateUrl of candidateUrls) {
    try {
      await downloadRemoteFile(candidateUrl, targetFilePath);
      return buildUserUploadPublicUrl(targetUserId, targetFileName);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError?.message
      ? `Não foi possível copiar o arquivo de mídia (${lastError.message})`
      : 'Não foi possível copiar o arquivo de mídia'
  );
};

const cloneProjectMediaFilesForUser = async (mediaFiles = {}, targetUserId) => {
  const clonedMediaFiles = {
    musicaOriginal: null,
    musicaInstrumental: null,
    video: null,
    imagem: null,
    ...(mediaFiles || {}),
  };

  const issues = [];

  for (const mediaKey of PROJECT_MEDIA_KEYS) {
    const sourceValue = mediaFiles?.[mediaKey];
    if (!sourceValue) {
      clonedMediaFiles[mediaKey] = null;
      continue;
    }

    try {
      clonedMediaFiles[mediaKey] = await cloneMediaFileToUserUploads(sourceValue, targetUserId, mediaKey);
    } catch (error) {
      clonedMediaFiles[mediaKey] = null;
      issues.push(`${mediaKey}: ${error.message}`);
    }
  }

  if (issues.length) {
    console.warn('Alguns arquivos de mídia do projeto não puderam ser copiados integralmente:', issues.join(' | '));
  }

  return clonedMediaFiles;
};

const buildOwnerMap = async (userIds = []) => {
  const uniqueUserIds = [...new Set((userIds || []).filter(Boolean))];
  if (!uniqueUserIds.length) {
    return {};
  }

  const ownerMap = Object.fromEntries(
    uniqueUserIds.map((userId) => [userId, { owner_name: UNKNOWN_OWNER_NAME, owner_email: null }])
  );

  const { data: owners, error: ownersError } = await supabase
    .from('users')
    .select('id, email')
    .in('id', uniqueUserIds);

  if (ownersError) {
    console.warn('Não foi possível carregar usuários da tabela users:', ownersError.message);
  } else {
    (owners || []).forEach((owner) => {
      ownerMap[owner.id] = {
        ...ownerMap[owner.id],
        owner_email: owner?.email || ownerMap[owner.id]?.owner_email || null,
      };
    });
  }

  await Promise.all(
    uniqueUserIds.map(async (userId) => {
      try {
        const { data, error } = await supabase.auth.admin.getUserById(userId);
        if (error || !data?.user) {
          if (error) {
            console.warn(`Não foi possível carregar metadata do usuário ${userId}:`, error.message);
          }
          return;
        }

        const displayName = extractDisplayNameFromAuthUser(data.user);
        ownerMap[userId] = {
          owner_name: displayName || ownerMap[userId]?.owner_name || UNKNOWN_OWNER_NAME,
          owner_email: data.user.email || ownerMap[userId]?.owner_email || null,
        };
      } catch (error) {
        console.warn(`Falha ao buscar metadata do usuário ${userId}:`, error.message);
      }
    })
  );

  return ownerMap;
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

    const ownerMap = await buildOwnerMap((projects || []).map((item) => item.user_id));

    const normalizedProjects = (projects || []).map((project) => ({
      ...normalizeProjectResponse(project),
      owner_name: ownerMap[project.user_id]?.owner_name || UNKNOWN_OWNER_NAME,
      owner_email: ownerMap[project.user_id]?.owner_email || null,
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

    const normalizedOriginalConfig = normalizeProjectPayload(originalProject.config || {});
    const lockedAudioType = resolveLockedAudioType(normalizedOriginalConfig);
    const sourceMediaFiles = restrictMediaFilesToLockedAudioType(
      normalizedOriginalConfig.mediaFiles || {},
      lockedAudioType
    );
    const clonedMediaFiles = await cloneProjectMediaFilesForUser(sourceMediaFiles, userId);

    if (lockedAudioType === 'original' && !clonedMediaFiles.musicaOriginal) {
      return res.status(422).json({
        error: 'O áudio original usado neste projeto público não está mais disponível para edição.',
      });
    }

    if (lockedAudioType === 'instrumental' && !clonedMediaFiles.musicaInstrumental) {
      return res.status(422).json({
        error: 'O playback usado neste projeto público não está mais disponível para edição.',
      });
    }

    const forkedConfig = {
      ...normalizedOriginalConfig,
      audioType: lockedAudioType || normalizedOriginalConfig.audioType || 'original',
      lockedAudioType: lockedAudioType || null,
      mediaFiles: clonedMediaFiles,
    };

    const forkName = requestedName || `${originalProject.name} (cópia)`;

    const { data: forkedProject, error: forkError } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        name: forkName,
        config: forkedConfig,
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
    return res.status(error.status || 500).json({
      error: error.message || 'Erro ao criar cópia do projeto',
      details: error.details || undefined,
    });
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
