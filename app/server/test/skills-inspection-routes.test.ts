import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { generateSecret } from '../src/auth/totp.js';
import { errorHandlerFor, HttpError } from '../src/routes/http.js';
import { skillsRouter } from '../src/addons/skills/routes.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

function fixture(opts: { observationsUnavailable?: boolean } = {}) {
  const f = skillsFixture();
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false,
    observations: async () => {
      if (opts.observationsUnavailable) throw new Error('Unavailable database fixture');
      return { acks: [], hosts: [], lastSeen: new Map() };
    } });
  const app = express();
  let routeError: unknown;
  app.use('/api/skills', skillsRouter(service));
  app.use((err: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => { routeError = err; next(err); });
  app.use(errorHandlerFor(false));
  return { f, app, routeError: () => routeError };
}

describe('skills inspection route conflicts', () => {
  for (const endpoint of ['file', 'detail']) {
    it.each([
      ['report', 'SKILL.md', skillMd('report', 'Updated description.', '', '# Changed instructions\n'), 0o644],
      ['clip', 'scripts/cut.sh', '#!/bin/sh\necho changed-script\n', 0o755],
    ] as const)(`maps cached %s/%s changes to a rescan conflict through ${endpoint}`, async (name, path, content, mode) => {
      const { f, app, routeError } = fixture();
      const initial = await request(app).get('/api/skills');
      expect(initial.status).toBe(200);
      expect(initial.headers['content-type']).toMatch(/application\/json/);
      expect(initial.body, initial.text.slice(0, 1000)).toHaveProperty('skills');
      const oldDigest = initial.body.skills.find((row: { name: string }) => row.name === name).effective.digest;
      write(join(f.vault, '.agents/skills', name, path), content, mode);
      const url = endpoint === 'file' ? `/api/skills/skill/${name}/file` : `/api/skills/skill/${name}`;
      const inspect = () => endpoint === 'file' ? request(app).get(url).query({ id: `private:${name}`, path }) : request(app).get(url);
      const conflict = await inspect();
      expect(conflict.status).toBe(409);
      expect(routeError()).toBeInstanceOf(HttpError);
      expect(routeError()).toMatchObject({ status: 409 });
      expect(conflict.body.error.message).toMatch(/changed since the catalog scan.*rescan/i);
      expect(conflict.body).not.toHaveProperty('content');
      expect(conflict.body).not.toHaveProperty('instructions');
      // A successful rescan establishes a new identity before inspection resumes.
      const refreshed = await request(app).get('/api/skills').query({ refresh: 1 });
      expect(refreshed.status).toBe(200);
      const newDigest = refreshed.body.skills.find((row: { name: string }) => row.name === name).effective.digest;
      expect(newDigest).not.toBe(oldDigest);
      const verified = await inspect();
      expect(verified.status).toBe(200);
      if (endpoint === 'file') expect(verified.body.content).toBe(content);
      else expect(verified.body.selected.digest).toBe(newDigest);
    });
  }

  it('preserves unknown skill and file 404 responses', async () => {
    const { app } = fixture();
    expect((await request(app).get('/api/skills/skill/no-such-skill')).status).toBe(404);
    expect((await request(app).get('/api/skills/skill/no-such-skill/file').query({ path: 'SKILL.md' })).status).toBe(404);
    expect((await request(app).get('/api/skills/skill/report/file').query({ path: 'missing.md' })).status).toBe(404);
  });

  it('maps unavailable machine observations to an explicit 503', async () => {
    const { app, routeError } = fixture({ observationsUnavailable: true });
    const response = await request(app).get('/api/skills/machines');
    expect(response.status).toBe(503);
    expect(routeError()).toBeInstanceOf(HttpError);
    expect(routeError()).toMatchObject({ status: 503 });
    expect(response.body.error.message).toMatch(/acknowledgement state could not be read/);
  });

  it('keeps both inspection routes behind the server session gate', async () => {
    const { f } = fixture();
    const app = createApp({ vaultRoot: f.vault, modules: new Set(['skills']), deployment: 'server',
      auth: { passwordHash: await hashPassword('inspection-fixture-passphrase'), totpSecret: generateSecret(), publicOrigin: 'https://brain.example.com', secureCookie: false } });
    expect((await request(app).get('/api/skills/skill/report')).status).toBe(401);
    expect((await request(app).get('/api/skills/skill/report/file').query({ path: 'SKILL.md' })).status).toBe(401);
  });
});
