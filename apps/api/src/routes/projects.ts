import { Hono } from 'hono';
import { z } from 'zod';
import { createProject, getProject, listProjects, updateProject } from '@junction26/db';
import type { AppEnv, Deps } from '../context.ts';
import { requireUser } from '../auth.ts';
import { notFound } from '../errors.ts';
import { param, projectView, readJson } from '../http.ts';

const Title = z.string().trim().min(1).max(80);

export function projectRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Library: users and devices. The glasses home shows the latest three.
  app.get('/', async (c) => {
    const items = await listProjects(deps.pool, c.get('principal').userId);
    return c.json({ projects: items.map(projectView) });
  });

  app.post('/', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const body = await readJson(c, z.object({ title: Title }));
    const project = await createProject(deps.pool, p.userId, body.title);
    c.get('log').info('project created', { projectId: project.id });
    return c.json({ project: projectView(project) }, 201);
  });

  app.get('/:projectId', async (c) => {
    const project = await getProject(deps.pool, c.get('principal').userId, param(c, 'projectId'));
    if (!project) throw notFound('Project');
    return c.json({ project: projectView(project) });
  });

  // Title edits come from authoring; `lastOpenedAt` can also come from a
  // device during sync (it only ever moves forward).
  app.patch('/:projectId', async (c) => {
    const p = c.get('principal');
    const body = await readJson(
      c,
      z.object({ title: Title.optional(), lastOpenedAt: z.iso.datetime().optional() }).refine((b) => b.title || b.lastOpenedAt, {
        message: 'Send title and/or lastOpenedAt',
      }),
    );
    if (body.title !== undefined) requireUser(p);
    const project = await updateProject(deps.pool, p.userId, param(c, 'projectId'), {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.lastOpenedAt !== undefined ? { lastOpenedAt: new Date(body.lastOpenedAt) } : {}),
    });
    if (!project) throw notFound('Project');
    return c.json({ project: projectView(project) });
  });

  return app;
}
