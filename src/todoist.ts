/**
 * Todoist — API client + HTTP route handler
 *
 * Uses the official @doist/todoist-api-typescript SDK.
 * Token read from .env at init time; never enters the container.
 *
 * Exports:
 *   - handleTodoistRequest: route handler for tools-proxy (/todoist/*)
 *   - Read operations: listTodoistTasks, getTodoistTask, listTodoistProjects
 *   - Write operations: createTodoistTask, closeTodoistTask
 *   - resolveProjectId: name → id lookup with caching
 */
import http from 'http';

import { TodoistApi } from '@doist/todoist-api-typescript';
import type { Task } from '@doist/todoist-api-typescript';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile(['TODOIST_API_TOKEN']);
const token = env.TODOIST_API_TOKEN || '';
const api = token ? new TodoistApi(token) : null;

// Project cache (name → id). Refreshed on cache miss.
let projectCache: Map<string, string> | null = null;

// --- Helpers ---

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res: http.ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

// --- Read operations ---

export async function listTodoistTasks(filter?: string, limit?: number): Promise<Task[]> {
  if (!api) throw new Error('Todoist not configured');

  if (filter) {
    const resp = await api.getTasksByFilter({ query: filter, limit });
    return resp.results;
  }
  const resp = await api.getTasks({ limit });
  return resp.results;
}

export async function getTodoistTask(taskId: string): Promise<Task> {
  if (!api) throw new Error('Todoist not configured');
  return api.getTask(taskId);
}

export async function listTodoistProjects() {
  if (!api) throw new Error('Todoist not configured');
  const resp = await api.getProjects();
  return resp.results;
}

// --- Write operations ---

export async function createTodoistTask(params: {
  content: string;
  description?: string;
  dueString?: string;
  projectId?: string;
  priority?: number;
  labels?: string[];
}): Promise<Task> {
  if (!api) throw new Error('Todoist not configured');
  return api.addTask(params);
}

export async function closeTodoistTask(taskId: string): Promise<boolean> {
  if (!api) throw new Error('Todoist not configured');
  return api.closeTask(taskId);
}

export async function resolveProjectId(projectName: string): Promise<string | null> {
  if (!api) return null;

  // Try cache first
  if (projectCache) {
    const id = projectCache.get(projectName.toLowerCase());
    if (id) return id;
  }

  // Refresh cache
  const projects = await listTodoistProjects();
  projectCache = new Map();
  for (const p of projects) {
    projectCache.set(p.name.toLowerCase(), p.id);
  }

  return projectCache.get(projectName.toLowerCase()) ?? null;
}

// --- Route handler ---

export async function handleTodoistRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!api) {
    errorResponse(res, 503, 'Todoist not configured');
    return;
  }

  if (req.method !== 'GET') {
    errorResponse(res, 405, 'Method not allowed');
    return;
  }

  const url = new URL(req.url!, 'http://localhost');
  const pathname = url.pathname;

  // GET /todoist/tasks?filter=...&limit=N
  // GET /todoist/tasks/:id
  if (pathname === '/todoist/tasks') {
    const filter = url.searchParams.get('filter') || undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200) : undefined;

    const tasks = await listTodoistTasks(filter, limit);
    jsonResponse(res, 200, tasks);
    return;
  }

  if (pathname.startsWith('/todoist/tasks/')) {
    const taskId = pathname.slice('/todoist/tasks/'.length);
    if (!taskId) {
      errorResponse(res, 400, 'Missing task ID');
      return;
    }
    const task = await getTodoistTask(taskId);
    jsonResponse(res, 200, task);
    return;
  }

  // GET /todoist/projects
  if (pathname === '/todoist/projects') {
    const projects = await listTodoistProjects();
    jsonResponse(res, 200, projects);
    return;
  }

  // GET /todoist/health
  if (pathname === '/todoist/health') {
    jsonResponse(res, 200, { status: 'ok', configured: true });
    return;
  }

  errorResponse(res, 404, 'Not found');
}

// Log configuration status at import time
if (api) {
  logger.info('Todoist: configured');
} else {
  logger.info('Todoist: not configured (no TODOIST_API_TOKEN)');
}
