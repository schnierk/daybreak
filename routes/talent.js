const express = require('express');

const CAREER_PATHS = new Set(['expert', 'leadership', 'project', 'undecided']);
const COMPETENCY_CATEGORIES = new Set(['technical', 'leadership', 'digital', 'methodological', 'social', 'language', 'business']);
const QUALIFICATION_TYPES = new Set(['qualification', 'certificate', 'education', 'training']);
const QUALIFICATION_STATUSES = new Set(['valid', 'expired', 'pending_verification', 'verified']);
const LANGUAGE_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']);
const GOAL_TYPES = new Set(['business', 'performance', 'development']);

function createTalentModule({ db, auth, current, isHr, isHrOperator = isHr, canViewEmployee, canEditEmployee, cleanText, boundedInt, validDate, log, hrCanAccess, blocksSelfEdit }) {
  const router = express.Router();
  const now = () => new Date().toISOString();
  const normalize = value => cleanText(value, 240).toLocaleLowerCase('de-DE').replace(/\s+/g, ' ').trim();
  // Findet „Ayşe“ mit „ayse“ und „Köhler“ mit „kohler“ oder „koehler“.
  const withoutMarks = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/ı/g, 'i');
  const searchForms = value => {
    const text = normalize(value);
    return [withoutMarks(text), withoutMarks(text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'))];
  };
  const matchesSearch = (haystack, needle) => {
    const wanted = withoutMarks(normalize(needle));
    return searchForms(haystack).some(form => form.includes(wanted));
  };
  const lastNameFirst = name => String(name).trim().split(/\s+/).reverse().join(' ');
  const bool = value => value === true || value === 'true' || value === 'on' || value === 1 || value === '1' ? 1 : 0;
  const text = (value, max = 4000) => cleanText(value, max);
  const own = (actor, userId) => actor.id === Number(userId);
  const visibleUser = (actor, userId) => canViewEmployee(actor, Number(userId));
  const editableUser = (actor, userId) => canEditEmployee(actor, Number(userId));
  const userById = id => db.prepare('SELECT id,name,email,role,title,manager_id,position_profile_id FROM users WHERE id=?').get(id);

  function ensureColumn(table, column, definition) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS career_interests (
        user_id INTEGER PRIMARY KEY REFERENCES users(id), career_path TEXT NOT NULL DEFAULT 'undecided' CHECK(career_path IN ('expert','leadership','project','undecided')),
        desired_fields TEXT, target_position TEXT, leadership_interest INTEGER NOT NULL DEFAULT 0, expert_interest INTEGER NOT NULL DEFAULT 0,
        project_interest INTEGER NOT NULL DEFAULT 0, mentoring_interest INTEGER NOT NULL DEFAULT 0, internal_projects_interest INTEGER NOT NULL DEFAULT 0,
        mobility INTEGER NOT NULL DEFAULT 0, relocation INTEGER NOT NULL DEFAULT 0, development_timeframe TEXT, career_goals TEXT,
        source TEXT NOT NULL DEFAULT 'employee', created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS career_interest_notes (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), note TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS professional_experiences (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), role_title TEXT NOT NULL, organization TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
        is_current INTEGER NOT NULL DEFAULT 0, description TEXT, key_responsibilities TEXT, source TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        CHECK(end_date IS NULL OR end_date >= start_date)
      );
      CREATE TABLE IF NOT EXISTS qualification_records (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), record_type TEXT NOT NULL CHECK(record_type IN ('qualification','certificate','education','training')),
        title TEXT NOT NULL, issuer TEXT, issued_at TEXT, expires_at TEXT, certificate_number TEXT, evidence_text TEXT,
        status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','expired','pending_verification','verified')), source TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        CHECK(expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at)
      );
      CREATE TABLE IF NOT EXISTS language_skills (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), language TEXT NOT NULL, language_normalized TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('A1','A2','B1','B2','C1','C2','native')),
        comment TEXT, source TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, language_normalized)
      );
      CREATE TABLE IF NOT EXISTS competencies (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_normalized TEXT NOT NULL UNIQUE, description TEXT, category TEXT NOT NULL CHECK(category IN ('technical','leadership','digital','methodological','social','language','business')),
        active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS competency_assessments (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), competency_id INTEGER NOT NULL REFERENCES competencies(id), assessor_id INTEGER NOT NULL REFERENCES users(id),
        assessment_type TEXT NOT NULL CHECK(assessment_type IN ('self','manager')), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT, evidence_text TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, competency_id, assessment_type, assessor_id)
      );
      CREATE TABLE IF NOT EXISTS competency_assessment_history (
        id INTEGER PRIMARY KEY, assessment_id INTEGER NOT NULL REFERENCES competency_assessments(id), user_id INTEGER NOT NULL REFERENCES users(id), competency_id INTEGER NOT NULL REFERENCES competencies(id),
        assessor_id INTEGER NOT NULL REFERENCES users(id), assessment_type TEXT NOT NULL, rating INTEGER NOT NULL, comment TEXT, evidence_text TEXT, changed_by INTEGER NOT NULL REFERENCES users(id), changed_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS position_profiles (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, title_normalized TEXT NOT NULL UNIQUE, description TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS position_requirements (
        id INTEGER PRIMARY KEY, position_profile_id INTEGER NOT NULL REFERENCES position_profiles(id), competency_id INTEGER NOT NULL REFERENCES competencies(id),
        required_level INTEGER NOT NULL CHECK(required_level BETWEEN 1 AND 5), mandatory INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 1 AND 100), comment TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(position_profile_id, competency_id)
      );
      CREATE TABLE IF NOT EXISTS position_assignment_history (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), previous_position_profile_id INTEGER REFERENCES position_profiles(id), position_profile_id INTEGER REFERENCES position_profiles(id),
        previous_position_title TEXT, position_title TEXT, effective_date TEXT NOT NULL, changed_by INTEGER REFERENCES users(id), recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source TEXT NOT NULL DEFAULT 'hr_assignment'
      );
      CREATE TABLE IF NOT EXISTS goal_competencies (
        goal_id INTEGER NOT NULL REFERENCES goals(id), competency_id INTEGER NOT NULL REFERENCES competencies(id), created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(goal_id, competency_id)
      );
      CREATE INDEX IF NOT EXISTS idx_experiences_user_active ON professional_experiences(user_id, active);
      CREATE INDEX IF NOT EXISTS idx_qualifications_user_active ON qualification_records(user_id, active);
      CREATE INDEX IF NOT EXISTS idx_languages_user_active ON language_skills(user_id, active);
      CREATE INDEX IF NOT EXISTS idx_assessments_user_competency ON competency_assessments(user_id, competency_id, active);
      CREATE INDEX IF NOT EXISTS idx_requirements_position_active ON position_requirements(position_profile_id, active);
      CREATE INDEX IF NOT EXISTS idx_position_history_user_effective ON position_assignment_history(user_id, effective_date DESC, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_goal_competencies_competency ON goal_competencies(competency_id);
    `);
    ensureColumn('users', 'position_profile_id', 'INTEGER REFERENCES position_profiles(id)');
    ensureColumn('users', 'is_system_account', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('goals', 'goal_type', "TEXT NOT NULL DEFAULT 'business'");
    db.prepare("UPDATE goals SET goal_type='business' WHERE goal_type IS NULL OR goal_type NOT IN ('business','performance','development')").run();
  }

  function currentComparisons(userId) {
    const rows = db.prepare(`SELECT a.*, c.name competency_name, c.category, c.active competency_active FROM competency_assessments a JOIN competencies c ON c.id=a.competency_id WHERE a.user_id=? AND a.active=1 ORDER BY datetime(a.updated_at) DESC, a.id DESC`).all(userId);
    const result = new Map();
    for (const row of rows) {
      if (!result.has(row.competency_id)) result.set(row.competency_id, { competencyId: row.competency_id, name: row.competency_name, category: row.category, active: !!row.competency_active, self: null, manager: null });
      const item = result.get(row.competency_id);
      if (row.assessment_type === 'self' && !item.self) item.self = row;
      if (row.assessment_type === 'manager' && !item.manager) item.manager = row;
    }
    return [...result.values()].map(item => ({ ...item, difference: item.self && item.manager ? item.manager.rating - item.self.rating : null, latestAt: [item.self?.updated_at, item.manager?.updated_at].filter(Boolean).sort((a,b) => Date.parse(a) - Date.parse(b)).pop() || null }));
  }

  /**
   * Abdeckung der Positionsanforderungen. Die Bewertung der Führungskraft geht vor der eigenen.
   * Für die Ebenen über der direkten Führungskraft zählt nur die eigene: Deren Note sollen sie nicht sehen.
   */
  function skillGap(userId, { withManagerRatings = true } = {}) {
    const user = db.prepare('SELECT u.id,u.position_profile_id,p.title position_title FROM users u LEFT JOIN position_profiles p ON p.id=u.position_profile_id WHERE u.id=?').get(userId);
    if (!user?.position_profile_id) return { position: null, requirements: [], fit: null, calculatedAt: now(), formula: 'Keine Positionsanforderungen hinterlegt.' };
    const requirements = db.prepare(`SELECT r.*,c.name competency_name,c.category,c.active competency_active FROM position_requirements r JOIN competencies c ON c.id=r.competency_id WHERE r.position_profile_id=? AND r.active=1 ORDER BY c.name`).all(user.position_profile_id);
    const comparisons = new Map(currentComparisons(userId).map(item => [item.competencyId, item]));
    let numerator = 0, denominator = 0;
    const values = requirements.map(req => {
      const comparison = comparisons.get(req.competency_id);
      const managerRating = withManagerRatings ? comparison?.manager : null;
      const assessment = managerRating || comparison?.self || null;
      const available = assessment ? assessment.rating : 0;
      const source = managerRating ? 'manager' : comparison?.self ? 'employee' : 'none';
      const gap = assessment ? req.required_level - available : null;
      const status = !assessment ? 'not_rated' : gap <= 0 ? 'fulfilled' : gap === 1 ? 'partial' : gap === 2 ? 'development_needed' : 'high_development_needed';
      const recommendation = !assessment ? 'Kompetenz bewerten' : gap <= 0 ? 'Anforderung erfüllt' : gap === 1 ? 'Gezielte Praxis oder Mentoring planen' : gap === 2 ? 'Konkretes Entwicklungsziel vereinbaren' : 'Prioritäres Entwicklungsziel und enges Follow-up vereinbaren';
      const weight = req.weight || 1;
      numerator += Math.min(available, req.required_level) * weight;
      denominator += req.required_level * weight;
      return { competencyId: req.competency_id, competency: req.competency_name, category: req.category, requiredLevel: req.required_level, availableLevel: assessment ? available : null, source, gap, status, recommendation, mandatory: !!req.mandatory, weight, assessmentAt: assessment?.updated_at || null };
    });
    return { position: { id: user.position_profile_id, title: user.position_title }, requirements: values, fit: denominator ? Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100))) : null, calculatedAt: now(), formula: 'Summe der auf das Anforderungsniveau begrenzten Kompetenzwerte × Gewicht / Summe der Anforderungsniveaus × Gewicht × 100' };
  }

  function talentSummary(userId) {
    const comparisons = currentComparisons(userId);
    const developmentGoals = db.prepare("SELECT COUNT(*) count FROM goals WHERE user_id=? AND goal_type='development' AND progress<100").get(userId).count;
    const career = db.prepare('SELECT target_position FROM career_interests WHERE user_id=?').get(userId);
    const gap = skillGap(userId);
    return { competencyCount: comparisons.length, missingManagerCount: comparisons.filter(item => item.self && !item.manager).length, developmentGoalCount: developmentGoals, targetPosition: career?.target_position || null, positionFit: gap.fit, highGapCount: gap.requirements.filter(item => item.status === 'high_development_needed').length };
  }

  function positionById(id) {
    return id ? db.prepare('SELECT id,title FROM position_profiles WHERE id=?').get(id) : null;
  }

  function recordPositionHistory({ userId, previousPositionId = null, positionId = null, effectiveDate, actor, source = 'hr_assignment' }) {
    const previous = positionById(previousPositionId);
    const position = positionById(positionId);
    return db.prepare(`INSERT INTO position_assignment_history(
      user_id,previous_position_profile_id,position_profile_id,previous_position_title,position_title,effective_date,changed_by,source
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      userId,
      previous?.id || null,
      position?.id || null,
      previous?.title || null,
      position?.title || null,
      effectiveDate,
      actor?.id || null,
      source
    ).lastInsertRowid;
  }

  function positionHistory(userId) {
    return db.prepare(`SELECT h.*,a.name changed_by_name
      FROM position_assignment_history h
      LEFT JOIN users a ON a.id=h.changed_by
      WHERE h.user_id=?
      ORDER BY h.effective_date DESC,h.recorded_at DESC,h.id DESC`).all(userId);
  }

  function getProfile(userId) {
    const user = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.title,u.manager_id,u.position_profile_id,p.title position_profile_title,p.description position_profile_description FROM users u LEFT JOIN position_profiles p ON p.id=u.position_profile_id WHERE u.id=?`).get(userId);
    if (!user) return null;
    const career = db.prepare('SELECT * FROM career_interests WHERE user_id=?').get(userId) || null;
    const notes = db.prepare('SELECT n.*,u.name author_name FROM career_interest_notes n JOIN users u ON u.id=n.created_by WHERE n.user_id=? ORDER BY n.created_at DESC').all(userId);
    const experiences = db.prepare('SELECT * FROM professional_experiences WHERE user_id=? AND active=1 ORDER BY is_current DESC,start_date DESC').all(userId);
    const qualifications = db.prepare('SELECT * FROM qualification_records WHERE user_id=? AND active=1 ORDER BY issued_at DESC').all(userId).map(item => ({ ...item, display_status: item.expires_at && item.expires_at < now().slice(0, 10) ? 'expired' : item.status }));
    const languages = db.prepare('SELECT * FROM language_skills WHERE user_id=? AND active=1 ORDER BY language').all(userId);
    const developmentGoals = db.prepare(`SELECT g.*,GROUP_CONCAT(c.name, ', ') competencies FROM goals g LEFT JOIN goal_competencies gc ON gc.goal_id=g.id LEFT JOIN competencies c ON c.id=gc.competency_id WHERE g.user_id=? AND g.goal_type='development' GROUP BY g.id ORDER BY g.due_date`).all(userId);
    return { user, career, careerNotes: notes, experiences, qualifications, languages, positionHistory: positionHistory(userId), comparisons: currentComparisons(userId), skillGap: skillGap(userId), developmentGoals, summary: talentSummary(userId) };
  }

  /**
   * HR-Hinweise sind nur für HR. Die Bewertung der Führungskraft sehen die Person, ihre direkte
   * Führungskraft und HR, aber nicht die Ebenen darüber.
   */
  const seesManagerRatings = (actor, person) => isHr(actor) || actor.id === person.id || person.manager_id === actor.id;

  function profileFor(actor, profile) {
    const careerNotes = isHr(actor) ? profile.careerNotes : [];
    if (seesManagerRatings(actor, profile.user)) return { ...profile, careerNotes, managerRatingsHidden: false };
    const gap = skillGap(profile.user.id, { withManagerRatings: false });
    return {
      ...profile,
      careerNotes,
      managerRatingsHidden: true,
      comparisons: profile.comparisons.map(item => ({ ...item, manager: null, difference: null, latestAt: item.self?.updated_at || null })),
      skillGap: gap,
      summary: { ...profile.summary, missingManagerCount: null, positionFit: gap.fit, highGapCount: gap.requirements.filter(item => item.status === 'high_development_needed').length }
    };
  }

  function auditUpdate(actor, action, entity, id, before, after) { log(actor.id, action, entity, id, before, after); }
  function existingActiveCompetency(id) { return db.prepare('SELECT * FROM competencies WHERE id=? AND active=1').get(id); }
  function findOwned(table, id, userId) { return db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id, userId); }
  function parseExperience(body) {
    const startDate = text(body.startDate, 10), endDate = text(body.endDate, 10) || null;
    if (!text(body.roleTitle, 180) || !text(body.organization, 180) || !validDate(startDate) || !validDate(endDate) || (endDate && endDate < startDate)) return null;
    return { roleTitle: text(body.roleTitle, 180), organization: text(body.organization, 180), startDate, endDate: bool(body.isCurrent) ? null : endDate, isCurrent: bool(body.isCurrent), description: text(body.description), responsibilities: text(body.responsibilities), source: 'employee' };
  }
  function parseQualification(body) {
    const type = body.recordType, status = body.status || 'valid', issuedAt = text(body.issuedAt, 10) || null, expiresAt = text(body.expiresAt, 10) || null;
    if (!QUALIFICATION_TYPES.has(type) || !QUALIFICATION_STATUSES.has(status) || !text(body.title, 240) || !validDate(issuedAt) || !validDate(expiresAt) || (issuedAt && expiresAt && expiresAt < issuedAt)) return null;
    return { type, status, title: text(body.title, 240), issuer: text(body.issuer, 240), issuedAt, expiresAt, certificateNumber: text(body.certificateNumber, 160), evidenceText: text(body.evidenceText), source: 'employee' };
  }

  router.use(auth);

  router.get('/talent/profile', (req, res) => {
    const actor = current(req);
    res.json({ profile: profileFor(actor, getProfile(actor.id)) });
  });
  router.get('/talent/profile/:userId', (req, res) => {
    const actor = current(req);
    const userId = Number(req.params.userId);
    if (!visibleUser(actor, userId)) return res.status(403).json({ error: 'Kein Leserecht für dieses Talentprofil.' });
    const profile = getProfile(userId);
    if (!profile) return res.status(404).json({ error: 'Talentprofil nicht gefunden.' });
    res.json({ profile: profileFor(actor, profile) });
  });
  router.get('/talent/dashboard', (req, res) => res.json({ summary: talentSummary(current(req).id) }));
  router.get('/talent/manager-dashboard', (req, res) => { const actor = current(req); if (!['manager', 'director', 'hr_admin', 'hrbp', 'super_admin'].includes(actor.role)) return res.status(403).json({ error: 'Keine Talent-Teamansicht verfügbar.' }); const users = isHr(actor) ? db.prepare('SELECT id,name,title FROM users WHERE is_system_account=0 AND active=1 ORDER BY name').all() : db.prepare('SELECT id,name,title FROM users WHERE manager_id=? AND is_system_account=0 AND active=1 ORDER BY name').all(actor.id); const team = users.map(user => ({ ...user, ...talentSummary(user.id) })); res.json({ team, missingManagerCount: team.reduce((sum, user) => sum + user.missingManagerCount, 0), highGapCount: team.reduce((sum, user) => sum + user.highGapCount, 0), openDevelopmentGoals: team.reduce((sum, user) => sum + user.developmentGoalCount, 0) }); });

  router.patch('/talent/career-interests', (req, res) => { const actor = current(req), path = req.body.careerPath || 'undecided'; if (!CAREER_PATHS.has(path)) return res.status(400).json({ error: 'Ungültiger Karrierepfad.' }); const payload = { careerPath: path, desiredFields: text(req.body.desiredFields), targetPosition: text(req.body.targetPosition, 180), leadershipInterest: bool(req.body.leadershipInterest), expertInterest: bool(req.body.expertInterest), projectInterest: bool(req.body.projectInterest), mentoringInterest: bool(req.body.mentoringInterest), internalProjectsInterest: bool(req.body.internalProjectsInterest), mobility: bool(req.body.mobility), relocation: bool(req.body.relocation), timeframe: text(req.body.developmentTimeframe, 120), goals: text(req.body.careerGoals) }; const previous = db.prepare('SELECT * FROM career_interests WHERE user_id=?').get(actor.id); const write = db.transaction(() => { if (previous) db.prepare(`UPDATE career_interests SET career_path=?,desired_fields=?,target_position=?,leadership_interest=?,expert_interest=?,project_interest=?,mentoring_interest=?,internal_projects_interest=?,mobility=?,relocation=?,development_timeframe=?,career_goals=?,updated_by=?,updated_at=? WHERE user_id=?`).run(payload.careerPath,payload.desiredFields,payload.targetPosition,payload.leadershipInterest,payload.expertInterest,payload.projectInterest,payload.mentoringInterest,payload.internalProjectsInterest,payload.mobility,payload.relocation,payload.timeframe,payload.goals,actor.id,now(),actor.id); else db.prepare(`INSERT INTO career_interests(user_id,career_path,desired_fields,target_position,leadership_interest,expert_interest,project_interest,mentoring_interest,internal_projects_interest,mobility,relocation,development_timeframe,career_goals,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(actor.id,payload.careerPath,payload.desiredFields,payload.targetPosition,payload.leadershipInterest,payload.expertInterest,payload.projectInterest,payload.mentoringInterest,payload.internalProjectsInterest,payload.mobility,payload.relocation,payload.timeframe,payload.goals,'employee',actor.id,actor.id); auditUpdate(actor,'career_interests_updated','career_interests',actor.id,previous,payload); }); write(); res.json({ ok: true }); });
  router.post('/talent/career-interests/:userId/notes', (req, res) => { const actor = current(req), userId = Number(req.params.userId), note = text(req.body.note); if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf administrative Ergänzungen hinterlegen.' }); if (!userById(userId) || !note) return res.status(400).json({ error: 'Person und Hinweis sind erforderlich.' }); const id = db.prepare('INSERT INTO career_interest_notes(user_id,note,created_by) VALUES(?,?,?)').run(userId,note,actor.id).lastInsertRowid; auditUpdate(actor,'career_interest_note_added','career_interest_notes',id,null,{userId,note}); res.json({ id }); });

  router.get('/talent/experiences', (req, res) => { const actor = current(req), userId = Number(req.query.userId) || actor.id; if (!visibleUser(actor,userId)) return res.status(403).json({ error: 'Kein Leserecht.' }); res.json({ items: db.prepare('SELECT * FROM professional_experiences WHERE user_id=? AND active=1 ORDER BY is_current DESC,start_date DESC').all(userId) }); });
  router.post('/talent/experiences', (req, res) => { const actor = current(req), data = parseExperience(req.body); if (!data) return res.status(400).json({ error: 'Berufserfahrung enthält ungültige Pflicht- oder Zeitangaben.' }); const id = db.prepare('INSERT INTO professional_experiences(user_id,role_title,organization,start_date,end_date,is_current,description,key_responsibilities,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(actor.id,data.roleTitle,data.organization,data.startDate,data.endDate,data.isCurrent,data.description,data.responsibilities,data.source,actor.id,actor.id).lastInsertRowid; auditUpdate(actor,'experience_created','professional_experiences',id,null,data); res.json({ id }); });
  router.patch('/talent/experiences/:id', (req,res) => { const actor=current(req), before=findOwned('professional_experiences',Number(req.params.id),actor.id), data=parseExperience(req.body); if(!before) return res.status(403).json({error:'Nur eigene Berufserfahrungen können bearbeitet werden.'}); if(!data) return res.status(400).json({error:'Ungültige Angaben.'}); db.prepare('UPDATE professional_experiences SET role_title=?,organization=?,start_date=?,end_date=?,is_current=?,description=?,key_responsibilities=?,updated_by=?,updated_at=? WHERE id=?').run(data.roleTitle,data.organization,data.startDate,data.endDate,data.isCurrent,data.description,data.responsibilities,actor.id,now(),before.id); auditUpdate(actor,'experience_updated','professional_experiences',before.id,before,data); res.json({ok:true}); });
  router.delete('/talent/experiences/:id', (req,res) => { const actor=current(req), before=findOwned('professional_experiences',Number(req.params.id),actor.id); if(!before) return res.status(403).json({error:'Nur eigene Berufserfahrungen können entfernt werden.'}); db.prepare('UPDATE professional_experiences SET active=0,updated_by=?,updated_at=? WHERE id=?').run(actor.id,now(),before.id); auditUpdate(actor,'experience_deactivated','professional_experiences',before.id,{active:before.active},{active:0}); res.json({ok:true}); });

  router.get('/talent/qualifications', (req,res) => { const actor=current(req), userId=Number(req.query.userId)||actor.id; if(!visibleUser(actor,userId)) return res.status(403).json({error:'Kein Leserecht.'}); const items=db.prepare('SELECT * FROM qualification_records WHERE user_id=? AND active=1 ORDER BY issued_at DESC').all(userId).map(item=>({...item,display_status:item.expires_at&&item.expires_at<now().slice(0,10)?'expired':item.status})); res.json({items}); });
  router.post('/talent/qualifications', (req,res) => { const actor=current(req), data=parseQualification(req.body); if(!data) return res.status(400).json({error:'Qualifikation enthält ungültige Angaben.'}); const id=db.prepare('INSERT INTO qualification_records(user_id,record_type,title,issuer,issued_at,expires_at,certificate_number,evidence_text,status,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(actor.id,data.type,data.title,data.issuer,data.issuedAt,data.expiresAt,data.certificateNumber,data.evidenceText,data.status,data.source,actor.id,actor.id).lastInsertRowid; auditUpdate(actor,'qualification_created','qualification_records',id,null,data); res.json({id}); });
  router.patch('/talent/qualifications/:id', (req,res) => { const actor=current(req), before=findOwned('qualification_records',Number(req.params.id),actor.id),data=parseQualification(req.body); if(!before) return res.status(403).json({error:'Nur eigene Qualifikationen können bearbeitet werden.'}); if(!data) return res.status(400).json({error:'Ungültige Angaben.'}); db.prepare('UPDATE qualification_records SET record_type=?,title=?,issuer=?,issued_at=?,expires_at=?,certificate_number=?,evidence_text=?,status=?,updated_by=?,updated_at=? WHERE id=?').run(data.type,data.title,data.issuer,data.issuedAt,data.expiresAt,data.certificateNumber,data.evidenceText,data.status,actor.id,now(),before.id); auditUpdate(actor,'qualification_updated','qualification_records',before.id,before,data);res.json({ok:true}); });
  router.delete('/talent/qualifications/:id', (req,res) => { const actor=current(req),before=findOwned('qualification_records',Number(req.params.id),actor.id);if(!before)return res.status(403).json({error:'Nur eigene Qualifikationen können entfernt werden.'});db.prepare('UPDATE qualification_records SET active=0,updated_by=?,updated_at=? WHERE id=?').run(actor.id,now(),before.id);auditUpdate(actor,'qualification_deactivated','qualification_records',before.id,{active:before.active},{active:0});res.json({ok:true}); });

  router.get('/talent/languages', (req,res) => { const actor=current(req),userId=Number(req.query.userId)||actor.id;if(!visibleUser(actor,userId))return res.status(403).json({error:'Kein Leserecht.'});res.json({items:db.prepare('SELECT * FROM language_skills WHERE user_id=? AND active=1 ORDER BY language').all(userId)}); });
  router.post('/talent/languages', (req,res) => { const actor=current(req),language=text(req.body.language,120),normalized=normalize(language),level=req.body.level,comment=text(req.body.comment);if(!language||!LANGUAGE_LEVELS.has(level))return res.status(400).json({error:'Sprache und gültiges Niveau sind erforderlich.'});const previous=db.prepare('SELECT * FROM language_skills WHERE user_id=? AND language_normalized=?').get(actor.id,normalized);if(previous&&previous.active)return res.status(409).json({error:'Diese Sprache ist bereits gepflegt.'});if(previous){db.prepare('UPDATE language_skills SET language=?,level=?,comment=?,active=1,updated_by=?,updated_at=? WHERE id=?').run(language,level,comment,actor.id,now(),previous.id);auditUpdate(actor,'language_updated','language_skills',previous.id,previous,{language,level,comment,active:1});return res.json({id:previous.id});}const id=db.prepare('INSERT INTO language_skills(user_id,language,language_normalized,level,comment,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)').run(actor.id,language,normalized,level,comment,'employee',actor.id,actor.id).lastInsertRowid;auditUpdate(actor,'language_created','language_skills',id,null,{language,level,comment});res.json({id}); });
  router.patch('/talent/languages/:id', (req,res) => { const actor=current(req),before=findOwned('language_skills',Number(req.params.id),actor.id),language=text(req.body.language,120),level=req.body.level,comment=text(req.body.comment);if(!before)return res.status(403).json({error:'Nur eigene Sprachen können bearbeitet werden.'});if(!language||!LANGUAGE_LEVELS.has(level))return res.status(400).json({error:'Ungültige Sprachangaben.'});const duplicate=db.prepare('SELECT id FROM language_skills WHERE user_id=? AND language_normalized=? AND id!=?').get(actor.id,normalize(language),before.id);if(duplicate)return res.status(409).json({error:'Diese Sprache ist bereits gepflegt.'});db.prepare('UPDATE language_skills SET language=?,language_normalized=?,level=?,comment=?,updated_by=?,updated_at=? WHERE id=?').run(language,normalize(language),level,comment,actor.id,now(),before.id);auditUpdate(actor,'language_updated','language_skills',before.id,before,{language,level,comment});res.json({ok:true}); });
  router.delete('/talent/languages/:id', (req,res) => { const actor=current(req),before=findOwned('language_skills',Number(req.params.id),actor.id);if(!before)return res.status(403).json({error:'Nur eigene Sprachen können entfernt werden.'});db.prepare('UPDATE language_skills SET active=0,updated_by=?,updated_at=? WHERE id=?').run(actor.id,now(),before.id);auditUpdate(actor,'language_deactivated','language_skills',before.id,{active:before.active},{active:0});res.json({ok:true}); });

  router.get('/competencies', (req,res) => { const actor=current(req), includeInactive=req.query.includeInactive==='true'&&isHr(actor);res.json({items:db.prepare(`SELECT * FROM competencies ${includeInactive?'':'WHERE active=1'} ORDER BY category,name`).all()}); });
  router.post('/competencies', (req,res) => { const actor=current(req),name=text(req.body.name,180),normalized=normalize(name),description=text(req.body.description),category=req.body.category;if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Kompetenzen verwalten.'});if(!name||!COMPETENCY_CATEGORIES.has(category))return res.status(400).json({error:'Name und gültige Kategorie sind erforderlich.'});try{const id=db.prepare('INSERT INTO competencies(name,name_normalized,description,category,created_by,updated_by) VALUES(?,?,?,?,?,?)').run(name,normalized,description,category,actor.id,actor.id).lastInsertRowid;auditUpdate(actor,'competency_created','competencies',id,null,{name,description,category});res.json({id});}catch{return res.status(409).json({error:'Diese Kompetenz existiert bereits.'});} });
  router.patch('/competencies/:id', (req,res) => { const actor=current(req),before=db.prepare('SELECT * FROM competencies WHERE id=?').get(req.params.id),name=text(req.body.name,180),description=text(req.body.description),category=req.body.category;if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Kompetenzen verwalten.'});if(!before)return res.status(404).json({error:'Kompetenz nicht gefunden.'});if(!name||!COMPETENCY_CATEGORIES.has(category))return res.status(400).json({error:'Ungültige Kompetenzangaben.'});try{db.prepare('UPDATE competencies SET name=?,name_normalized=?,description=?,category=?,updated_by=?,updated_at=? WHERE id=?').run(name,normalize(name),description,category,actor.id,now(),before.id);auditUpdate(actor,'competency_updated','competencies',before.id,before,{name,description,category});res.json({ok:true});}catch{return res.status(409).json({error:'Diese Kompetenz existiert bereits.'});} });
  router.patch('/competencies/:id/active', (req,res) => { const actor=current(req),before=db.prepare('SELECT * FROM competencies WHERE id=?').get(req.params.id),active=bool(req.body.active);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Kompetenzen deaktivieren.'});if(!before)return res.status(404).json({error:'Kompetenz nicht gefunden.'});db.prepare('UPDATE competencies SET active=?,updated_by=?,updated_at=? WHERE id=?').run(active,actor.id,now(),before.id);auditUpdate(actor,active?'competency_activated':'competency_deactivated','competencies',before.id,{active:before.active},{active});res.json({ok:true}); });

  function saveAssessment(actor, userId, competencyId, assessmentType, rating, comment, evidenceText) { const existing=db.prepare('SELECT * FROM competency_assessments WHERE user_id=? AND competency_id=? AND assessment_type=? AND assessor_id=?').get(userId,competencyId,assessmentType,actor.id); const transaction=db.transaction(()=>{if(existing){db.prepare('INSERT INTO competency_assessment_history(assessment_id,user_id,competency_id,assessor_id,assessment_type,rating,comment,evidence_text,changed_by) VALUES(?,?,?,?,?,?,?,?,?)').run(existing.id,existing.user_id,existing.competency_id,existing.assessor_id,existing.assessment_type,existing.rating,existing.comment,existing.evidence_text,actor.id);db.prepare('UPDATE competency_assessments SET rating=?,comment=?,evidence_text=?,active=1,updated_at=? WHERE id=?').run(rating,comment,evidenceText,now(),existing.id);auditUpdate(actor,assessmentType==='self'?'self_assessment_updated':'manager_assessment_updated','competency_assessments',existing.id,{rating:existing.rating,comment:existing.comment,evidenceText:existing.evidence_text},{rating,comment,evidenceText});return existing.id;}const id=db.prepare('INSERT INTO competency_assessments(user_id,competency_id,assessor_id,assessment_type,rating,comment,evidence_text) VALUES(?,?,?,?,?,?,?)').run(userId,competencyId,actor.id,assessmentType,rating,comment,evidenceText).lastInsertRowid;auditUpdate(actor,assessmentType==='self'?'self_assessment_created':'manager_assessment_created','competency_assessments',id,null,{userId,competencyId,rating,comment,evidenceText});return id;});return transaction(); }
  function clearAssessment(actor, userId, competencyId, assessmentType) {
    const existing=db.prepare('SELECT * FROM competency_assessments WHERE user_id=? AND competency_id=? AND assessment_type=? AND active=1 ORDER BY id DESC').get(userId,competencyId,assessmentType);
    if(!existing)return null;
    const transaction=db.transaction(()=>{
      // Eine ältere Bewertung der früheren Führungskraft darf danach nicht wieder auftauchen.
      db.prepare('UPDATE competency_assessments SET active=0,updated_at=? WHERE user_id=? AND competency_id=? AND assessment_type=? AND active=1 AND id<>?').run(now(),userId,competencyId,assessmentType,existing.id);
      db.prepare('INSERT INTO competency_assessment_history(assessment_id,user_id,competency_id,assessor_id,assessment_type,rating,comment,evidence_text,changed_by) VALUES(?,?,?,?,?,?,?,?,?)').run(existing.id,existing.user_id,existing.competency_id,existing.assessor_id,existing.assessment_type,existing.rating,existing.comment,existing.evidence_text,actor.id);
      db.prepare('UPDATE competency_assessments SET active=0,updated_at=? WHERE id=?').run(now(),existing.id);
      auditUpdate(actor,assessmentType==='self'?'self_assessment_cleared':'manager_assessment_cleared','competency_assessments',existing.id,{rating:existing.rating,comment:existing.comment,evidenceText:existing.evidence_text,active:1},{rating:null,comment:'',evidenceText:'',active:0});
      return existing.id;
    });
    return transaction();
  }
  router.post('/talent/competencies/self-assessment', (req,res) => { const actor=current(req),competencyId=Number(req.body.competencyId),rating=boundedInt(req.body.rating,1,5,null),comment=text(req.body.comment),evidenceText=text(req.body.evidenceText);if(!existingActiveCompetency(competencyId)||!rating)return res.status(400).json({error:'Aktive Kompetenz und Bewertung von 1 bis 5 sind erforderlich.'});res.json({id:saveAssessment(actor,actor.id,competencyId,'self',rating,comment,evidenceText)}); });
  router.post('/talent/competencies/manager-assessment', (req,res) => { const actor=current(req),userId=Number(req.body.userId),competencyId=Number(req.body.competencyId),rating=boundedInt(req.body.rating,1,5,null),comment=text(req.body.comment);if(userById(userId)?.manager_id!==actor.id||actor.id===userId)return res.status(403).json({error:'Nur die direkte Führungskraft darf bewerten.'});if(!existingActiveCompetency(competencyId)||!rating)return res.status(400).json({error:'Aktive Kompetenz und Bewertung von 1 bis 5 sind erforderlich.'});res.json({id:saveAssessment(actor,userId,competencyId,'manager',rating,comment,'')}); });
  router.post('/talent/competencies/manager-assessments', (req,res) => {
    const actor=current(req),userId=Number(req.body.userId),items=Array.isArray(req.body.assessments)?req.body.assessments:[];
    if(userById(userId)?.manager_id!==actor.id||actor.id===userId)return res.status(403).json({error:'Nur die direkte Führungskraft darf bewerten.'});
    if(!items.length||items.length>100)return res.status(400).json({error:'Mindestens eine und höchstens 100 Kompetenzbewertungen sind erforderlich.'});
    const seen=new Set(),assessments=[];
    for(const item of items){
      const competencyId=Number(item?.competencyId),hasRating=item?.rating!==null&&item?.rating!==''&&item?.rating!==undefined,rating=hasRating?boundedInt(item.rating,1,5,null):null,comment=text(item?.comment);
      if(!Number.isInteger(competencyId)||seen.has(competencyId)||!existingActiveCompetency(competencyId)||(hasRating&&!rating))return res.status(400).json({error:'Jede Kompetenz darf nur einmal und entweder mit einer Bewertung von 1 bis 5 oder als „Nicht bewertet“ übermittelt werden.'});
      seen.add(competencyId);assessments.push({competencyId,rating,comment});
    }
    const ids=assessments.map(item=>item.rating?saveAssessment(actor,userId,item.competencyId,'manager',item.rating,item.comment,''):clearAssessment(actor,userId,item.competencyId,'manager'));
    res.json({ids,cleared:assessments.filter(item=>!item.rating).length});
  });

  router.get('/positions', (req,res) => { const actor=current(req),includeInactive=req.query.includeInactive==='true'&&isHr(actor);res.json({items:db.prepare(`SELECT * FROM position_profiles ${includeInactive?'':'WHERE active=1'} ORDER BY title`).all()}); });
  router.post('/positions', (req,res) => { const actor=current(req),title=text(req.body.title,180),description=text(req.body.description);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Positionsprofile verwalten.'});if(!title)return res.status(400).json({error:'Ein Positionstitel ist erforderlich.'});try{const id=db.prepare('INSERT INTO position_profiles(title,title_normalized,description,created_by,updated_by) VALUES(?,?,?,?,?)').run(title,normalize(title),description,actor.id,actor.id).lastInsertRowid;auditUpdate(actor,'position_created','position_profiles',id,null,{title,description});res.json({id});}catch{return res.status(409).json({error:'Dieses Positionsprofil existiert bereits.'});} });
  router.patch('/positions/:id', (req,res) => { const actor=current(req),before=db.prepare('SELECT * FROM position_profiles WHERE id=?').get(req.params.id),title=text(req.body.title,180),description=text(req.body.description);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Positionsprofile verwalten.'});if(!before)return res.status(404).json({error:'Positionsprofil nicht gefunden.'});if(!title)return res.status(400).json({error:'Ein Positionstitel ist erforderlich.'});try{db.prepare('UPDATE position_profiles SET title=?,title_normalized=?,description=?,updated_by=?,updated_at=? WHERE id=?').run(title,normalize(title),description,actor.id,now(),before.id);auditUpdate(actor,'position_updated','position_profiles',before.id,before,{title,description});res.json({ok:true});}catch{return res.status(409).json({error:'Dieses Positionsprofil existiert bereits.'});} });
  router.patch('/positions/:id/active', (req,res) => { const actor=current(req),before=db.prepare('SELECT * FROM position_profiles WHERE id=?').get(req.params.id),active=bool(req.body.active);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Positionsprofile deaktivieren.'});if(!before)return res.status(404).json({error:'Positionsprofil nicht gefunden.'});db.prepare('UPDATE position_profiles SET active=?,updated_by=?,updated_at=? WHERE id=?').run(active,actor.id,now(),before.id);auditUpdate(actor,active?'position_activated':'position_deactivated','position_profiles',before.id,{active:before.active},{active});res.json({ok:true}); });
  router.patch('/positions/assign/:userId', (req,res) => {
    const actor=current(req);
    const userId=Number(req.params.userId);
    const positionId=req.body.positionProfileId?Number(req.body.positionProfileId):null;
    const effectiveDate=text(req.body.effectiveDate,10);
    const before=userById(userId);
    if(!isHrOperator(actor))return res.status(403).json({error:'Nur HR darf Positionsprofile zuordnen.'});
    if(positionId!==null&&!Number.isInteger(positionId))return res.status(400).json({error:'Ungültige Person oder Position.'});
    if(!before||positionId&&!db.prepare('SELECT id FROM position_profiles WHERE id=? AND active=1').get(positionId))return res.status(400).json({error:'Ungültige Person oder Position.'});
    if(blocksSelfEdit?.(actor,userId))return res.status(403).json({error:'Deine eigene Position ändert eine andere HR-Person.'});
    if(hrCanAccess&&!hrCanAccess(actor,userId))return res.status(403).json({error:'Diese Position darf nur die HR-Administration ändern.'});
    if(!effectiveDate||!validDate(effectiveDate))return res.status(400).json({error:'Bitte gib an, ab wann die Positionsänderung offiziell wirksam ist.'});
    // Die Zuordnung wirkt sofort. Ein Datum in der Zukunft würde etwas anderes versprechen.
    if(effectiveDate>new Date().toISOString().slice(0,10))return res.status(400).json({error:'Die Position wirkt sofort. Trage als Datum spätestens heute ein.'});
    if(before.position_profile_id===positionId)return res.status(400).json({error:'Diese Positionszuordnung besteht bereits. Es wurde keine Änderung gespeichert.'});
    const historyId=db.transaction(()=>{
      db.prepare('UPDATE users SET position_profile_id=? WHERE id=?').run(positionId,userId);
      return recordPositionHistory({userId,previousPositionId:before.position_profile_id,positionId,effectiveDate,actor});
    })();
    auditUpdate(actor,'position_assigned','users',userId,{positionProfileId:before.position_profile_id},{positionProfileId:positionId,effectiveDate,historyId});
    res.json({ok:true,historyId});
  });
  router.get('/positions/:id/requirements', (req,res) => { const actor=current(req),positionId=Number(req.params.id);if(!userById(actor.id))return res.status(401).json({error:'Nicht angemeldet.'});res.json({items:db.prepare('SELECT r.*,c.name competency_name,c.category,c.active competency_active FROM position_requirements r JOIN competencies c ON c.id=r.competency_id WHERE r.position_profile_id=? ORDER BY c.name').all(positionId)}); });
  router.post('/positions/:id/requirements', (req,res) => { const actor=current(req),positionId=Number(req.params.id),competencyId=Number(req.body.competencyId),requiredLevel=boundedInt(req.body.requiredLevel,1,5,null),weight=boundedInt(req.body.weight,1,100,1),comment=text(req.body.comment),mandatory=bool(req.body.mandatory);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Positionsanforderungen verwalten.'});if(!db.prepare('SELECT id FROM position_profiles WHERE id=? AND active=1').get(positionId)||!existingActiveCompetency(competencyId)||!requiredLevel)return res.status(400).json({error:'Aktive Position, aktive Kompetenz und Niveau 1 bis 5 sind erforderlich.'});try{const id=db.prepare('INSERT INTO position_requirements(position_profile_id,competency_id,required_level,mandatory,weight,comment,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)').run(positionId,competencyId,requiredLevel,mandatory,weight,comment,actor.id,actor.id).lastInsertRowid;auditUpdate(actor,'position_requirement_created','position_requirements',id,null,{positionId,competencyId,requiredLevel,mandatory,weight,comment});res.json({id});}catch{return res.status(409).json({error:'Diese Kompetenzanforderung existiert bereits.'});} });
  router.patch('/positions/requirements/:id', (req,res) => { const actor=current(req),before=db.prepare('SELECT * FROM position_requirements WHERE id=?').get(req.params.id),requiredLevel=boundedInt(req.body.requiredLevel,1,5,null),weight=boundedInt(req.body.weight,1,100,1),comment=text(req.body.comment),mandatory=bool(req.body.mandatory);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Positionsanforderungen verwalten.'});if(!before)return res.status(404).json({error:'Anforderung nicht gefunden.'});if(!requiredLevel)return res.status(400).json({error:'Niveau 1 bis 5 ist erforderlich.'});db.prepare('UPDATE position_requirements SET required_level=?,mandatory=?,weight=?,comment=?,updated_by=?,updated_at=? WHERE id=?').run(requiredLevel,mandatory,weight,comment,actor.id,now(),before.id);auditUpdate(actor,'position_requirement_updated','position_requirements',before.id,before,{requiredLevel,mandatory,weight,comment});res.json({ok:true}); });
  router.patch('/positions/requirements/:id/active', (req,res) => { const actor=current(req),before=db.prepare('SELECT * FROM position_requirements WHERE id=?').get(req.params.id),active=bool(req.body.active);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf Positionsanforderungen deaktivieren.'});if(!before)return res.status(404).json({error:'Anforderung nicht gefunden.'});db.prepare('UPDATE position_requirements SET active=?,updated_by=?,updated_at=? WHERE id=?').run(active,actor.id,now(),before.id);auditUpdate(actor,active?'position_requirement_activated':'position_requirement_deactivated','position_requirements',before.id,{active:before.active},{active});res.json({ok:true}); });

  router.get('/talent/skill-gap/:userId', (req,res) => { const actor=current(req),userId=Number(req.params.userId);if(!visibleUser(actor,userId))return res.status(403).json({error:'Kein Leserecht für diese Kompetenzlücken-Auswertung.'});res.json({analysis:skillGap(userId,{withManagerRatings:seesManagerRatings(actor,userById(userId))})}); });
  router.get('/talent/development-goals', (req,res) => { const actor=current(req),userId=Number(req.query.userId)||actor.id;if(!visibleUser(actor,userId))return res.status(403).json({error:'Kein Leserecht.'});res.json({items:db.prepare(`SELECT g.*,GROUP_CONCAT(c.name, ', ') competencies FROM goals g LEFT JOIN goal_competencies gc ON gc.goal_id=g.id LEFT JOIN competencies c ON c.id=gc.competency_id WHERE g.user_id=? AND g.goal_type='development' GROUP BY g.id ORDER BY g.due_date`).all(userId)}); });
  router.post('/talent/development-goals/:goalId/competencies', (req,res) => { const actor=current(req),goalId=Number(req.params.goalId),competencyId=Number(req.body.competencyId),goal=db.prepare("SELECT * FROM goals WHERE id=? AND goal_type='development'").get(goalId);if(!goal||!(own(actor,goal.user_id)||editableUser(actor,goal.user_id)))return res.status(403).json({error:'Kein Recht zur Verknüpfung dieses Entwicklungsziels.'});if(!existingActiveCompetency(competencyId))return res.status(400).json({error:'Nur aktive Kompetenzen können verknüpft werden.'});try{db.prepare('INSERT INTO goal_competencies(goal_id,competency_id,created_by) VALUES(?,?,?)').run(goalId,competencyId,actor.id);auditUpdate(actor,'development_goal_competency_linked','goal_competencies',goalId,null,{competencyId});res.json({ok:true});}catch{return res.status(409).json({error:'Diese Kompetenz ist bereits verknüpft.'});} });
  router.delete('/talent/development-goals/:goalId/competencies/:competencyId', (req,res) => { const actor=current(req),goalId=Number(req.params.goalId),competencyId=Number(req.params.competencyId),goal=db.prepare("SELECT * FROM goals WHERE id=? AND goal_type='development'").get(goalId);if(!goal||!(own(actor,goal.user_id)||editableUser(actor,goal.user_id)))return res.status(403).json({error:'Kein Recht zur Verknüpfung dieses Entwicklungsziels.'});const info=db.prepare('DELETE FROM goal_competencies WHERE goal_id=? AND competency_id=?').run(goalId,competencyId);if(!info.changes)return res.status(404).json({error:'Verknüpfung nicht gefunden.'});auditUpdate(actor,'development_goal_competency_unlinked','goal_competencies',goalId,{competencyId},null);res.json({ok:true}); });
  router.get('/talent/overview', (req,res) => { const actor=current(req);if(!isHr(actor))return res.status(403).json({error:'Nur HR darf die Talentübersicht öffnen.'});const search=normalize(req.query.search||''),managerId=Number(req.query.managerId)||null,positionId=Number(req.query.positionId)||null,competencyId=Number(req.query.competencyId)||null,missingManager=req.query.missingManager==='true',gapStatus=req.query.gapStatus||null;let users=db.prepare('SELECT id,name,email,title,manager_id,position_profile_id FROM users WHERE is_system_account=0 AND active=1').all().sort((a,b)=>lastNameFirst(a.name).localeCompare(lastNameFirst(b.name),'de'));if(search)users=users.filter(user=>matchesSearch(`${user.name} ${user.title||''} ${user.email}`,search));if(managerId)users=users.filter(user=>user.manager_id===managerId);if(positionId)users=users.filter(user=>user.position_profile_id===positionId);const rows=users.map(user=>{const summary=talentSummary(user.id),gap=skillGap(user.id);return {...user,...summary,gapStatuses:gap.requirements.map(item=>item.status)};}).filter(row=>(!competencyId||currentComparisons(row.id).some(item=>item.competencyId===competencyId))&&(!missingManager||row.missingManagerCount>0)&&(!gapStatus||row.gapStatuses.includes(gapStatus)));res.json({rows}); });

  function seed() {
    const admin = db.prepare("SELECT id FROM users WHERE role='hr_admin' AND is_system_account=0 ORDER BY id LIMIT 1").get()?.id;
    const manager = db.prepare("SELECT id FROM users WHERE role IN ('manager','director') ORDER BY id LIMIT 1").get()?.id;
    if (!admin) return;
    const competencies = [
      ['Produktdesign','technical'],['UX Research','technical'],['Datenanalyse','digital'],['Präsentation','social'],['Stakeholdermanagement','business'],['Projektmanagement','methodological'],['Agile Arbeitsweisen','methodological'],['Designsysteme','technical'],['Nutzerzentrierung','technical'],['Konfliktlösung','social'],['Strategisches Denken','business'],['Coaching','leadership'],['Führung von Teams','leadership'],['Digitale Zusammenarbeit','digital'],['Prozessoptimierung','methodological'],['Kommunikation','social'],['Englisch','language'],['Kundenorientierung','business'],['Innovation','business'],['Moderation','social'],['Priorisierung','methodological'],['Datenvisualisierung','digital']
    ];
    const insertCompetency=db.prepare('INSERT OR IGNORE INTO competencies(name,name_normalized,description,category,created_by,updated_by) VALUES(?,?,?,?,?,?)');
    competencies.forEach(([name,category])=>insertCompetency.run(name,normalize(name),`Beispiel für eine Kompetenz: ${name}.`,category,admin,admin));
    const positions=['Senior Product Designer','Product Designer','UX Researcher','Head of Product','Chief People Officer','HR Business Partner'];
    const insertPosition=db.prepare('INSERT OR IGNORE INTO position_profiles(title,title_normalized,description,created_by,updated_by) VALUES(?,?,?,?,?)');
    positions.forEach(title=>insertPosition.run(title,normalize(title),`Wiederverwendbares Positionsprofil für ${title}.`,admin,admin));
    db.prepare('UPDATE users SET position_profile_id=(SELECT id FROM position_profiles p WHERE p.title_normalized=lower(trim(users.title))) WHERE position_profile_id IS NULL AND EXISTS(SELECT 1 FROM position_profiles p WHERE p.title_normalized=lower(trim(users.title)))').run();
    const positionId=title=>db.prepare('SELECT id FROM position_profiles WHERE title=?').get(title)?.id;
    const competencyId=name=>db.prepare('SELECT id FROM competencies WHERE name=?').get(name)?.id;
    const addRequirement=db.prepare('INSERT OR IGNORE INTO position_requirements(position_profile_id,competency_id,required_level,mandatory,weight,comment,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)');
    const requirements={
      'Senior Product Designer':[['Produktdesign',4,1,3],['Designsysteme',4,1,2],['Präsentation',4,1,2],['Stakeholdermanagement',4,1,3],['UX Research',3,0,1]],
      'Product Designer':[['Produktdesign',3,1,3],['Nutzerzentrierung',3,1,2],['Designsysteme',3,0,1],['Kommunikation',3,1,2]],
      'UX Researcher':[['UX Research',4,1,3],['Datenanalyse',3,1,2],['Moderation',3,1,2],['Präsentation',3,1,2]],
      'Head of Product':[['Strategisches Denken',4,1,3],['Führung von Teams',4,1,3],['Stakeholdermanagement',4,1,2],['Priorisierung',4,1,2]]
    };
    Object.entries(requirements).forEach(([title,items])=>items.forEach(([name,level,mandatory,weight])=>addRequirement.run(positionId(title),competencyId(name),level,mandatory,weight,'Anforderung der Position',admin,admin)));
    const employees=db.prepare("SELECT id,name FROM users WHERE role='employee' ORDER BY id LIMIT 3").all();
    const interest=db.prepare('INSERT OR IGNORE INTO career_interests(user_id,career_path,desired_fields,target_position,leadership_interest,expert_interest,project_interest,mentoring_interest,internal_projects_interest,mobility,relocation,development_timeframe,career_goals,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    employees.forEach((user,index)=>interest.run(user.id,index===0?'expert':index===1?'project':'undecided','Produkt, Nutzererlebnis und Zusammenarbeit',index===0?'Lead Product Designer':'Projektleitung',0,1,index===1?1:0,1,1,0,0,'12–24 Monate','Ich möchte mehr Verantwortung im Produktbereich übernehmen.','employee',user.id,user.id));
    const qualification=db.prepare('INSERT OR IGNORE INTO qualification_records(user_id,record_type,title,issuer,issued_at,status,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?)');
    const language=db.prepare('INSERT OR IGNORE INTO language_skills(user_id,language,language_normalized,level,comment,source,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)');
    employees.forEach((user,index)=>{qualification.run(user.id,index===1?'certificate':'training',index===1?'Professional Scrum Certificate':'Human-Centered Design Weiterbildung','Demo Academy','2025-05-15','verified','employee',user.id,user.id);language.run(user.id,'Englisch','englisch',index===0?'C1':'B2','Stand aus dem letzten Gespräch.','employee',user.id,user.id);});
    const assessment=db.prepare('INSERT OR IGNORE INTO competency_assessments(user_id,competency_id,assessor_id,assessment_type,rating,comment,evidence_text) VALUES(?,?,?,?,?,?,?)');
    employees.forEach((user,index)=>{[['Produktdesign',index===0?4:3],['Präsentation',index===0?4:3],['Stakeholdermanagement',index===0?3:2]].forEach(([name,rating])=>{const id=competencyId(name);assessment.run(user.id,id,user.id,'self',rating,'Das mache ich regelmäßig im Alltag.','');if(manager)assessment.run(user.id,id,manager,'manager',Math.max(1,rating-(name==='Stakeholdermanagement'?1:0)),'Sicher in der Praxis. Im nächsten Projekt weiter ausbauen.','');});});
    const first=employees[0];
    if(first&&!db.prepare("SELECT id FROM goals WHERE user_id=? AND title='Präsentationskompetenz ausbauen'").get(first.id)){const goalId=db.prepare("INSERT INTO goals(user_id,title,description,weight,progress,status,due_date,created_by,approval_status,goal_type) VALUES(?,?,?,?,?,?,?,?,?,?)").run(first.id,'Präsentationskompetenz ausbauen','In drei bereichsübergreifenden Terminen Ergebnisse strukturiert präsentieren.',20,20,'on_track','2026-12-31',manager||admin,'approved','development').lastInsertRowid;const presentation=competencyId('Präsentation');if(presentation)db.prepare('INSERT OR IGNORE INTO goal_competencies(goal_id,competency_id,created_by) VALUES(?,?,?)').run(goalId,presentation,manager||admin);}
  }

  return { initialize, seed, router, skillGap, talentSummary, recordPositionHistory };
}

module.exports = { createTalentModule, GOAL_TYPES };
