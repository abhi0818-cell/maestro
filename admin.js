/**
 * admin.js — Maestro admin panel
 *
 * Loaded lazily only for admin users. See loadAdminModule() in index.html.
 *
 * Context is provided via window.__app (set by index.html before auth):
 *   A.state, A.PLAYERS, A.$, A.toast, A.render, A.renderPool, ...
 *
 * A.PLAYERS is accessed as A.PLAYERS everywhere (not destructured) because
 * the array reference is reassigned on each data load in index.html.
 */
/* global window */
(function () {
  'use strict';

  const A = window.__app;                    // shared app context from index.html
  const state                = A.state;      // same object, mutations visible both ways
  const $                    = A.$;
  const toast                = A.toast;
  const render               = A.render;
  const renderPool           = A.renderPool;
  const renderSavedTeams     = A.renderSavedTeams;
  const renderHistory        = A.renderHistory;
  const renderMatchSelector  = A.renderMatchSelector;
  const renderTeamFilter     = A.renderTeamFilter;
  const renderScorecard      = A.renderScorecard;
  const renderScores         = A.renderScores;
  const SCORING_RULES        = A.SCORING_RULES;
  const DEFAULT_SCORING_RULES = A.DEFAULT_SCORING_RULES;
  const BOOSTER_META         = A.BOOSTER_META;
  const getBoosterMeta       = A.getBoosterMeta;
  const iconHtml             = A.iconHtml;
  const ADMIN_EMAIL          = A.ADMIN_EMAIL;
  const escapeHtml           = A.escapeHtml;
  const playerById           = A.playerById;
  const findLocalByName      = A.findLocalByName;
  const mergeApiPlayersByLocalId = A.mergeApiPlayersByLocalId;
  const teamCodes            = A.teamCodes;
  const teamByCode           = A.teamByCode;
  const isAdmin              = A.isAdmin;
  const fromCricAPI          = A.fromCricAPI;
  const isTournamentStarted       = A.isTournamentStarted;
  const switchTournament          = A.switchTournament;
  const renderReviewQueues        = A.renderReviewQueues;
  const wireDuplicatePlayersToggle = A.wireDuplicatePlayersToggle;
  const KNOWN_TEAMS               = A.KNOWN_TEAMS;
  const API_KEY_LS                = 'ss_cricapi_key'; // mirrors index.html constant
  // constants
  const KNOWN_ROLES               = A.KNOWN_ROLES;
  const MULTIPLIERS               = A.MULTIPLIERS;
  const NAME_ALIASES              = A.NAME_ALIASES;
  const RULES                     = A.RULES;
  const RULE_GROUP_ORDER          = A.RULE_GROUP_ORDER;
  const RULE_META                 = A.RULE_META;
  // index.html functions called by admin.js
  const applyDotBallGate          = A.applyDotBallGate;
  const buildLiveScorecardFromStats = A.buildLiveScorecardFromStats;
  const calcFielding              = A.calcFielding;
  const calculateScore            = A.calculateScore;
  const connectLive               = A.connectLive;
  const forcePollNow              = A.forcePollNow;
  const matchLifecycle            = A.matchLifecycle;
  const maybeStartLbPolling       = A.maybeStartLbPolling;
  const persistLiveSlScores       = A.persistLiveSlScores;
  const refreshAllPlayerIds       = A.refreshAllPlayerIds;
  const renderLeaderboard         = A.renderLeaderboard;
  const renderSlLiveTab           = A.renderSlLiveTab;
  const renderSlXiTab             = A.renderSlXiTab;
  const summarizeFieldingIssues   = A.summarizeFieldingIssues;
  const afterTeamCodeFix          = A.afterTeamCodeFix;
  // NB: A.PLAYERS    — always read as A.PLAYERS    (reference reassigned on data loads)
  // NB: A.TEAMS_DATA — always read as A.TEAMS_DATA (reference reassigned on data loads)
  // NB: A.ALL_PLAYER_IDS / A.playersSource — use A. prefix for reads AND writes

    // ─── MATCH DATA-SOURCE TRACK RESOLUTION ─────────────────────────────────
    /**
     * Resolves which data source a match should be scored from: 'cricapi' or
     * 'scraper'. A per-match `data_source` override ('cricapi'/'scraper') wins
     * over the tournament's `scraper_enabled` default; 'auto' (or unset) falls
     * back to that default.
     *
     * This is the client-side copy of the exact same eligibility rule already
     * implemented server-side in poll-cricapi/index.ts and
     * scrape-scorecard/index.ts — kept here as the single client-side source
     * of truth so admin.js's per-match actions (Finalize, Score Audit, Poll/
     * Scrape visibility) don't each re-derive it separately. See
     * docs/score_audit_track_streamline_plan.md.
     *
     * @param {object} match       a matches row — only `data_source` is read
     * @param {object} tournament  the match's tournament row — only `scraper_enabled` is read
     * @returns {'cricapi'|'scraper'}
     */
    function resolveMatchTrack(match, tournament) {
      const src = match?.data_source || 'auto';
      if (src === 'cricapi') return 'cricapi';
      if (src === 'scraper') return 'scraper';
      return tournament?.scraper_enabled ? 'scraper' : 'cricapi';
    }

    // ─── PLAYER ADMIN ────────────────────────────────────────────────────────
    // All functions below this point (through RULES EDITOR) live in admin.js
    // and are loaded lazily for admin users. See loadAdminModule() in BOOT.
    function openAdmin() {
      if (!isAdmin()) { toast('Admin access is restricted.'); return; }
      $('#adminModal').classList.add('open');
      $('#adminStatus').textContent = state.db
        ? 'Edits save to Postgres on blur.'
        : 'Connect a database in the Tournament tab to edit. Local-mode edits are not persisted.';
      renderAdmin();
    }
    function closeAdmin() { $('#adminModal').classList.remove('open'); }

    function setAdminTab(tab) {
      state.adminTab = tab;
      document.querySelectorAll('.a-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      const title = {
        tournament : 'Tournament Setup',
        teams      : 'Manage Teams',
        schedule   : 'Schedule',
        contests   : 'Contests',
        live       : 'Live',
        review     : 'Review',
        dangerzone : 'Danger Zone',
        reference  : 'Reference',
      }[tab] || 'Manage Players';
      $('#adminTitle').textContent = title;
      $('#adminTournamentView').style.display = (tab === 'tournament') ? 'flex'  : 'none';
      $('#adminTableView').style.display      = (tab === 'players')    ? 'block' : 'none';
      $('#adminTeamsView').style.display      = (tab === 'teams')      ? 'block' : 'none';
      $('#adminMatchesView').style.display    = (tab === 'schedule')   ? 'block' : 'none';
      $('#adminScoringView').style.display    = 'none'; // Scoring tab removed — folded into Tournament
      $('#adminContestsView').style.display   = (tab === 'contests')   ? 'block' : 'none';
      $('#adminLiveView').style.display       = (tab === 'live')       ? 'block' : 'none';
      $('#adminReviewView').style.display     = (tab === 'review')     ? 'block' : 'none';
      $('#adminDangerZoneView').style.display = (tab === 'dangerzone') ? 'block' : 'none';
      $('#adminReferenceView').style.display  = (tab === 'reference')  ? 'block' : 'none';
      $('#adminCsvView').style.display        = 'none';
      $('#adminPhotoCsvView').style.display   = 'none';
      $('#matchesCsvView').style.display      = 'none';
      // Toolbar (search + import) is only useful for players
      document.querySelector('.admin-toolbar').style.display = (tab === 'players') ? 'flex' : 'none';
      if (tab === 'tournament')    renderTournamentScoringRules();
      else if (tab === 'teams')    renderTeamsAdmin();
      else if (tab === 'schedule') renderMatchesAdmin();
      else if (tab === 'contests') renderContestsAdmin();
      else if (tab === 'dangerzone') renderDangerZone();
      else if (tab === 'review')   { renderTeamsMismatchBanner(); renderReviewQueues?.(); wireDuplicatePlayersToggle?.(); }
      else if (tab === 'live')     { renderLiveTournamentBar(); renderLiveMatchTrackControls(); }
      else if (tab === 'reference') { /* static content, no render needed */ }
      else                         renderAdmin();
    }

    /**
     * Build the HTML for the booster configuration panel inside a contest card.
     * Shows one row per booster type: checkbox (enabled) + number input (uses).
     * contestId is used to build unique input IDs; available is the current JSONB value or null.
     */
    // `opts.showSaveButton` (default true) renders its own "Save Boosters" button —
    // used for private leagues, which stay independently editable. Season-long
    // contests pass `showSaveButton:false` so this grid is just one part of the
    // single consolidated Save button on the contest card (see renderContestsAdmin).
    // `opts.disabled` greys out the whole grid — used to lock season-long booster
    // config once the tournament has started.
    function buildBoosterConfigHtml(contestId, available, opts = {}) {
      const { showSaveButton = true, disabled = false } = opts;
      const av = available || {};
      const rows = Object.entries(BOOSTER_META).map(([key, rawMeta]) => {
        const meta    = getBoosterMeta ? (getBoosterMeta(key) ?? rawMeta) : rawMeta;
        const enabled = key in av;
        const count   = av[key] ?? 1;
        const uid     = `boost_${key}_${contestId.replace(/-/g,'')}`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);">
          <input type="checkbox" id="${uid}_chk" data-booster="${key}" class="boost-chk" ${enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="flex-shrink:0;" />
          <label for="${uid}_chk" style="font-size:12px;flex:1;cursor:pointer;">
            ${iconHtml ? iconHtml(meta.icon, meta.label) : meta.icon} <strong>${meta.label}</strong>
            <span style="color:var(--muted);font-size:11px;margin-left:4px;">${meta.desc}</span>
          </label>
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--muted);">Uses:</span>
            <input type="number" min="1" max="10" value="${count}" id="${uid}_count"
              style="width:50px;font-size:12px;padding:3px 6px;" ${(enabled && !disabled) ? '' : 'disabled'} />
          </div>
        </div>`;
      }).join('');
      return `<div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--muted);">⚡ Boosters</div>
        <div id="boostGrid_${contestId.replace(/-/g,'')}">${rows}</div>
        ${showSaveButton ? `
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
          <button class="primary boost-save-btn" data-contest="${contestId}" style="font-size:12px;padding:4px 12px;">Save Boosters</button>
          <span class="boost-status" data-contest="${contestId}" style="font-size:11px;color:var(--muted);"></span>
        </div>` : ''}
      </div>`;
    }

    // ── Close-Out Tournament panel ────────────────────────────────────────────
    // Injected at the top of the Contests tab. Lets the admin:
    //   • Preview row counts for every tournament-scoped table
    //   • Toggle which tables to wipe
    //   • Execute the close-out (end_date = today + optional deletes)

    function renderCloseOutPanel(preselectedId) {
      const panelId = 'closeOutPanel';
      const existing = $(`#${panelId}`);
      if (existing) existing.remove();

      const panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = [
        'border:1px solid var(--bad)',
        'border-radius:8px',
        'padding:14px 16px',
        'margin-bottom:16px',
        'background:rgba(248,113,113,0.04)',
      ].join(';');

      // Build tournament options for dropdown
      const hasTournaments = state.tournaments && state.tournaments.length > 0;
      const tournamentOptions = hasTournaments
        ? state.tournaments.map(t => {
            const sel = t.id === preselectedId ? ' selected' : '';
            const label = escapeHtml(t.name) + ' (' + (t.format || 'T20') + ')';
            return `<option value="${t.id}"${sel}>${label}</option>`;
          }).join('')
        : '<option value="">— no tournaments found —</option>';

      panel.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">🏁</span>
            <strong style="font-size:14px;color:var(--bad);">Close Out Tournament</strong>
          </div>
          <button id="coPreviewBtn" style="font-size:12px;padding:5px 12px;" ${hasTournaments ? '' : 'disabled'}>
            Preview data
          </button>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px;">
            Tournament to close out
          </label>
          <select id="coTournamentSelect" style="width:100%;font-size:13px;" ${hasTournaments ? '' : 'disabled'}>
            ${hasTournaments ? '' : ''}
            <option value="" ${preselectedId ? 'style="display:none"' : ''}>— select a tournament —</option>
            ${tournamentOptions}
          </select>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px;">
          Marks the selected tournament as finished (sets <code>end_date = today</code>,
          <code>is_active = false</code>, and deactivates all contests). Optionally wipe
          transactional tables below — reference data (players, teams, profiles) is never touched.
        </p>
        <div id="coTableList" style="display:none;margin-bottom:12px;"></div>
        <div id="coActions" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;">
          <button id="coExecuteBtn" class="danger" style="font-size:13px;padding:7px 18px;" disabled>
            Close Out Tournament
          </button>
          <span id="coStatus" style="font-size:12px;color:var(--muted);"></span>
        </div>
      `;

      // Insert into the Danger Zone tab's close-out slot
      const slot = $('#dzCloseOutSlot');
      slot.appendChild(panel);

      // Reset preview when the dropdown changes
      panel.querySelector('#coTournamentSelect').addEventListener('change', () => {
        const listEl  = $('#coTableList');
        const actions = $('#coActions');
        const execBtn = $('#coExecuteBtn');
        if (listEl)  { listEl.style.display  = 'none'; listEl.innerHTML  = ''; }
        if (actions) { actions.style.display = 'none'; }
        if (execBtn) { execBtn.disabled = true; }
        $('#coStatus') && ($('#coStatus').textContent = '');
      });

      // ── Preview button ───────────────────────────────────────────────────────
      $('#coPreviewBtn').addEventListener('click', async () => {
        const selectedId = $('#coTournamentSelect')?.value;
        if (!selectedId) { toast('Select a tournament first.'); return; }

        const btn = $('#coPreviewBtn');
        const listEl = $('#coTableList');
        const actionsEl = $('#coActions');
        btn.disabled = true;
        btn.textContent = 'Loading…';
        listEl.style.display = 'none';
        actionsEl.style.display = 'none';

        try {
          const counts = await state.db.getTournamentTableCounts(selectedId);

          listEl.innerHTML = `
            <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
              Select tables to clear
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead>
                <tr>
                  <th style="text-align:left;padding:4px 6px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600;">Clear?</th>
                  <th style="text-align:left;padding:4px 6px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600;">Table</th>
                  <th style="text-align:left;padding:4px 6px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600;">Description</th>
                  <th style="text-align:right;padding:4px 6px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600;">Rows</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(counts).map(([key, t]) => `
                  <tr>
                    <td style="padding:6px 6px;">
                      <input type="checkbox"
                        class="co-table-chk"
                        data-table="${key}"
                        ${t.defaultOn ? 'checked' : ''}
                        style="cursor:pointer;"
                      />
                    </td>
                    <td style="padding:6px 6px;">
                      <code style="font-size:11px;background:var(--panel-2);padding:2px 6px;border-radius:4px;">${key}</code>
                      <div style="font-size:11px;font-weight:600;margin-top:2px;">${t.label}</div>
                    </td>
                    <td style="padding:6px 6px;color:var(--muted);font-size:11px;">${t.description}</td>
                    <td style="padding:6px 6px;text-align:right;">
                      <span style="font-size:13px;font-weight:700;color:${t.count > 0 ? 'var(--accent-2)' : 'var(--muted)'};">${t.count.toLocaleString()}</span>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
            <div style="font-size:11px;color:var(--muted);margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
              ✅ Always kept (not shown): <code>players</code>, <code>teams</code>, <code>profiles</code>, <code>tournaments</code>
            </div>
          `;

          listEl.style.display = 'block';
          actionsEl.style.display = 'flex';

          // Enable execute once we have count data
          const execBtn = $('#coExecuteBtn');
          execBtn.disabled = false;

          // Update button label when checkboxes change
          function updateExecLabel() {
            const checked = [...listEl.querySelectorAll('.co-table-chk:checked')].map(c => c.dataset.table);
            const totalRows = checked.reduce((sum, key) => sum + (counts[key]?.count ?? 0), 0);
            execBtn.textContent = checked.length === 0
              ? 'Close Out (flag only — no deletions)'
              : `Close Out + Delete ${totalRows.toLocaleString()} rows from ${checked.length} table${checked.length !== 1 ? 's' : ''}`;
          }
          updateExecLabel();
          listEl.querySelectorAll('.co-table-chk').forEach(chk => {
            chk.addEventListener('change', updateExecLabel);
          });

        } catch (e) {
          listEl.innerHTML = `<div style="color:var(--bad);font-size:12px;">Failed to load counts: ${escapeHtml(e.message)}</div>`;
          listEl.style.display = 'block';
        } finally {
          btn.disabled = false;
          btn.textContent = '↻ Refresh';
        }
      });

      // ── Execute button ───────────────────────────────────────────────────────
      panel.addEventListener('click', async (e) => {
        if (e.target.id !== 'coExecuteBtn') return;
        const selectedId = $('#coTournamentSelect')?.value;
        if (!selectedId) { toast('Select a tournament first.'); return; }

        const selectedName = $('#coTournamentSelect').options[$('#coTournamentSelect').selectedIndex]?.text ?? selectedId;
        const btn = e.target;
        const statusEl = $('#coStatus');
        const listEl = $('#coTableList');

        const tablesToClear = [...listEl.querySelectorAll('.co-table-chk:checked')]
          .map(c => c.dataset.table);

        const tableLabel = tablesToClear.length === 0
          ? 'No tables will be deleted — only end_date and is_active flags will be updated.'
          : `This will permanently delete rows from: ${tablesToClear.join(', ')}.`;

        if (!confirm(
          `⚠️  Close out "${selectedName}"?\n\n${tableLabel}\n\nThis cannot be undone.`
        )) return;

        btn.disabled = true;
        statusEl.textContent = 'Running…';
        statusEl.style.color = 'var(--muted)';

        try {
          const result = await state.db.closeOutTournament(selectedId, tablesToClear);

          if (result.errors.length) {
            statusEl.textContent = `Partial: cleared ${result.tablesCleared.length} table(s). Errors: ${result.errors.join(' | ')}`;
            statusEl.style.color = 'var(--bad)';
          } else {
            const msg = result.tablesCleared.length === 0
              ? '✓ Tournament closed out — flags updated, no rows deleted.'
              : `✓ Done — deleted rows from: ${result.tablesCleared.join(', ')}. Tournament marked finished.`;
            statusEl.textContent = msg;
            statusEl.style.color = 'var(--good,#4ade80)';
            // Refresh the counts after close-out
            $('#coPreviewBtn')?.click();
          }
        } catch (err) {
          statusEl.textContent = 'Failed: ' + err.message;
          statusEl.style.color = 'var(--bad)';
          btn.disabled = false;
        }
      });
    }

    // ── Danger Zone tab ─────────────────────────────────────────────────────
    // Delete Tournament (moved from Tournament tab) + Close Out Tournament
    // (moved from Contests tab) — both destructive, both end-of-season/setup-
    // correction actions, neither belongs alongside routine mid-season work.
    function renderDangerZone() {
      const select = $('#dzTournamentSelect');
      const btn    = $('#dzDeleteBtn');
      const statusEl = $('#dzDeleteStatus');
      if (!select || !btn) return;

      const hasTournaments = state.tournaments && state.tournaments.length > 0;
      select.innerHTML = '<option value="">— select a tournament —</option>' +
        (hasTournaments
          ? state.tournaments.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${t.format || 'T20'})</option>`).join('')
          : '');
      select.disabled = !hasTournaments;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = '';

      select.onchange = () => { btn.disabled = !select.value; };

      btn.onclick = async () => {
        const tid   = select.value;
        const tname = select.options[select.selectedIndex]?.text ?? tid;
        if (!tid) return;
        if (!confirm(
          `Delete "${tname}"?\n\nThis permanently removes the tournament row. If it has any matches, players, or contests attached, the delete will fail and nothing will be changed.\n\nThis cannot be undone.`
        )) return;

        btn.disabled = true;
        if (statusEl) { statusEl.textContent = 'Deleting…'; statusEl.style.color = 'var(--muted)'; }
        try {
          await state.db.deleteTournament(tid);
          state.tournaments = state.tournaments.filter(x => x.id !== tid);
          if (state.activeTournamentId === tid) {
            state.activeTournamentId = state.tournaments[0]?.id ?? null;
          }
          renderTournamentSelector();
          renderScheduleTournamentContext();
          renderDangerZone();
          toast(`"${tname}" deleted.`);
        } catch (err) {
          const hint = err.message?.includes('foreign key') || err.message?.includes('violates')
            ? ' It still has matches, players, or contests attached — remove those first, or use Close Out instead.'
            : '';
          if (statusEl) {
            statusEl.textContent = `Delete failed: ${err.message}.${hint}`;
            statusEl.style.color = 'var(--bad)';
          }
          btn.disabled = false;
        }
      };

      renderCloseOutPanel(state.activeTournamentId ?? null);
    }

    function renderNewContestForm(isEmpty) {
      const activeTournament = state.tournaments.find(t => t.id === state.activeTournamentId);
      const tName = activeTournament ? escapeHtml(activeTournament.name) : 'the active tournament';
      const boosterRows = Object.entries(BOOSTER_META).map(([key, rawMeta]) => {
        const meta = getBoosterMeta ? (getBoosterMeta(key) ?? rawMeta) : rawMeta;
        return `
        <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);">
          <input type="checkbox" id="ncBoost_${key}" data-booster="${key}" class="nc-boost-chk" style="flex-shrink:0;" />
          <label for="ncBoost_${key}" style="font-size:12px;flex:1;cursor:pointer;">
            ${iconHtml ? iconHtml(meta.icon, meta.label) : meta.icon} <strong>${meta.label}</strong>
            <span style="color:var(--muted);font-size:11px;margin-left:4px;">${meta.desc}</span>
          </label>
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--muted);">Uses:</span>
            <input type="number" min="1" max="10" value="1" id="ncBoost_${key}_count"
              style="width:50px;font-size:12px;padding:3px 6px;" disabled />
          </div>
        </div>`;
      }).join('');

      return `
        <div id="newContestForm" style="border:1px solid var(--border); border-radius:8px;
             padding:14px 16px; margin-top:${isEmpty ? '0' : '16px'};
             background:rgba(201,168,76,0.04);">
          <div style="font-size:13px; font-weight:600; color:var(--accent); margin-bottom:4px;">
            ${isEmpty ? '🏆 No contests yet' : '＋ Add Contest'}
          </div>
          <div style="font-size:11px; color:var(--muted); margin-bottom:12px;">
            Creating for: <strong style="color:var(--text);">${tName}</strong>
          </div>
          ${isEmpty ? `<p style="font-size:12px; color:var(--muted); margin:0 0 12px;">
            A tournament needs at least one public contest before users can play.
            Create a <strong>Daily</strong> contest (single-match XI each game) and/or a
            <strong>Season Long</strong> contest (one squad, weekly transfers).
          </p>` : ''}

          <!-- Name + Type row -->
          <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin-bottom:12px;">
            <div style="display:flex; flex-direction:column; gap:4px; flex:1; min-width:180px;">
              <label style="font-size:11px; color:var(--muted); font-weight:600;">Contest name</label>
              <input id="ncName" type="text" placeholder="e.g. IPL 2026 Daily, IPL 2026 Season Long"
                     style="font-size:13px;" />
            </div>
            <div style="display:flex; flex-direction:column; gap:4px;">
              <label style="font-size:11px; color:var(--muted); font-weight:600;">Type</label>
              <select id="ncType" style="font-size:13px; padding:6px 10px;">
                <option value="daily">Daily (per-match XI)</option>
                <option value="season_long">Season Long (squad + transfers)</option>
              </select>
            </div>
          </div>

          <!-- Season Long config — hidden until type = season_long -->
          <div id="ncSlConfig" style="display:none; border:1px solid var(--border); border-radius:6px; padding:12px 14px; margin-bottom:12px; background:rgba(34,211,238,0.03);">
            <div style="font-size:12px; font-weight:600; color:var(--muted); margin-bottom:10px;">⚙️ Season Long settings</div>

            <!-- Transfer settings -->
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
              <div style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:11px; color:var(--muted); font-weight:600;">Total transfer budget
                  <span style="font-weight:400;">(blank = unlimited)</span></label>
                <input id="ncTotalXfers" type="number" min="0" step="1" placeholder="Unlimited"
                       style="font-size:13px; padding:6px 9px;" />
              </div>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:11px; color:var(--muted); font-weight:600;">Free transfers per match</label>
                <select id="ncFreeXfersPerMatch" style="font-size:13px; padding:6px 9px;">
                  <option value="na">N/A — no per-match allocation</option>
                  <option value="0">0 — every transfer costs pts</option>
                  <option value="1">1 free per match</option>
                  <option value="2">2 free per match</option>
                  <option value="3">3 free per match</option>
                  <option value="unlimited">Unlimited free (no penalty)</option>
                </select>
              </div>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <label id="ncXferCostLabel" style="font-size:11px; color:var(--muted); font-weight:600;">Extra transfer cost (pts)
                  <span style="font-weight:400;">(per transfer over free allowance)</span></label>
                <input id="ncXferCost" type="number" min="0" step="1" value="4"
                       style="font-size:13px; padding:6px 9px;" />
              </div>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:11px; color:var(--muted); font-weight:600;">Season start match #
                  <span style="font-weight:400;">(blank = all matches)</span></label>
                <input id="ncStartMN" type="number" min="1" step="1" placeholder="All matches"
                       style="font-size:13px; padding:6px 9px;" />
              </div>
            </div>

            <!-- Playoff section -->
            <div style="border-top:1px solid var(--border); padding-top:10px; margin-bottom:10px;">
              <div style="font-size:11px; font-weight:600; color:var(--muted); margin-bottom:8px;">🏟️ Playoff phase
                <span style="font-weight:400;">(leave blank if no playoff phase)</span></div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <label style="font-size:11px; color:var(--muted); font-weight:600;">Playoff start match #</label>
                  <input id="ncPlayoffStartMN" type="number" min="1" step="1" placeholder="No playoffs"
                         style="font-size:13px; padding:6px 9px;" />
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <label style="font-size:11px; color:var(--muted); font-weight:600;">Playoff transfer budget
                    <span style="font-weight:400;">(blank = unlimited)</span></label>
                  <input id="ncPlayoffXfers" type="number" min="0" step="1" placeholder="Unlimited"
                         style="font-size:13px; padding:6px 9px;" />
                </div>
              </div>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--muted); margin-top:8px;">
                <input id="ncPlayoffFirstUnlimited" type="checkbox" checked />
                First playoff match has unlimited, cost-free transfers (excluded from the budget above)
                <span style="font-weight:400;">— on by default, uncheck only as a deliberate exception</span>
              </label>
            </div>

            <!-- Boosters -->
            <div style="border-top:1px solid var(--border); padding-top:10px;">
              <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--muted);">⚡ Boosters
                <span style="font-weight:400;">(check to enable, set how many uses each member gets)</span></div>
              <div id="ncBoostersGrid">${boosterRows}</div>
            </div>
          </div>

          <button id="ncCreateBtn" class="primary" style="font-size:13px; padding:7px 18px; white-space:nowrap;">
            Create contest
          </button>
          <div id="ncStatus" style="font-size:11px; color:var(--muted); margin-top:8px;"></div>
        </div>`;
    }

    function wireNewContestForm() {
      const btn      = $('#ncCreateBtn');
      const statusEl = $('#ncStatus');
      const typeEl   = $('#ncType');
      const slConfig = $('#ncSlConfig');
      if (!btn) return;

      // Show/hide SL config section based on type
      const toggleSlConfig = () => {
        if (slConfig) slConfig.style.display = typeEl.value === 'season_long' ? 'block' : 'none';
      };
      typeEl.addEventListener('change', toggleSlConfig);

      // Grey out extra transfer cost when free transfers = N/A
      const freeXferEl  = $('#ncFreeXfersPerMatch');
      const xferCostEl  = $('#ncXferCost');
      const xferCostLbl = $('#ncXferCostLabel');
      const toggleXferCost = () => {
        const isNA = freeXferEl && freeXferEl.value === 'na';
        if (xferCostEl)  { xferCostEl.disabled = isNA; xferCostEl.style.opacity = isNA ? '0.4' : '1'; }
        if (xferCostLbl) xferCostLbl.style.opacity = isNA ? '0.4' : '1';
      };
      if (freeXferEl) freeXferEl.addEventListener('change', toggleXferCost);

      // Wire booster checkboxes — enable/disable count inputs
      document.querySelectorAll('.nc-boost-chk').forEach(chk => {
        chk.addEventListener('change', () => {
          const countEl = $(`#ncBoost_${chk.dataset.booster}_count`);
          if (countEl) countEl.disabled = !chk.checked;
        });
      });

      btn.addEventListener('click', async () => {
        const name        = $('#ncName').value.trim();
        const contestType = typeEl.value;
        if (!name) { statusEl.textContent = 'Enter a contest name.'; statusEl.style.color = 'var(--bad)'; return; }
        if (!state.activeTournamentId) { statusEl.textContent = 'No active tournament selected.'; statusEl.style.color = 'var(--bad)'; return; }

        const parseIntOrNull = raw => (raw == null || String(raw).trim() === '' ? null : parseInt(raw, 10));

        const opts = { name, contestType };

        if (contestType === 'season_long') {
          opts.totalTransfersAllowed    = parseIntOrNull($('#ncTotalXfers')?.value);
          // Free transfers: 'na' → null (no per-match tracking), 'unlimited' → null,
          // numeric string → that integer
          const freeVal = freeXferEl?.value ?? 'na';
          opts.freeTransfersPerMatch    = (freeVal === 'na' || freeVal === 'unlimited') ? null : parseInt(freeVal, 10);
          // Extra cost: irrelevant when N/A — store as 0 so no accidental deductions
          opts.extraTransferPointCost   = (freeVal === 'na') ? 0 : (parseIntOrNull($('#ncXferCost')?.value) ?? 4);
          opts.startMatchNumber         = parseIntOrNull($('#ncStartMN')?.value);
          opts.playoffStartMatchNumber  = parseIntOrNull($('#ncPlayoffStartMN')?.value);
          opts.playoffTransfersAllowed  = parseIntOrNull($('#ncPlayoffXfers')?.value);
          opts.playoffFirstMatchUnlimited = !!$('#ncPlayoffFirstUnlimited')?.checked;

          // Collect enabled boosters
          const boosters = {};
          document.querySelectorAll('.nc-boost-chk').forEach(chk => {
            if (chk.checked) {
              const countEl = $(`#ncBoost_${chk.dataset.booster}_count`);
              boosters[chk.dataset.booster] = parseInt(countEl?.value || '1', 10);
            }
          });
          opts.availableBoosters = Object.keys(boosters).length > 0 ? boosters : null;
        }

        btn.disabled = true;
        statusEl.textContent = 'Creating…';
        statusEl.style.color = 'var(--muted)';
        try {
          await state.db.createContest(state.activeTournamentId, opts);
          toast(`Contest "${name}" created.`);
          renderContestsAdmin(); // full re-render so the new card appears
        } catch (e) {
          statusEl.textContent = 'Failed: ' + e.message;
          statusEl.style.color = 'var(--bad)';
          btn.disabled = false;
        }
      });
    }

    function renderContestsTournamentBar(contestCount) {
      const sw    = $('#contestsTournamentSwitch');
      const badge = $('#contestsCountBadge');
      if (!sw) return;
      sw.innerHTML = state.tournaments.length
        ? state.tournaments.map(t =>
            `<option value="${t.id}" ${t.id === state.activeTournamentId ? 'selected' : ''}>${escapeHtml(t.name)} (${t.format || 'T20'})</option>`
          ).join('')
        : '<option value="">— no tournaments loaded —</option>';
      if (badge) {
        badge.textContent = contestCount === null ? '' :
          contestCount === 0 ? 'No contests yet' :
          `${contestCount} contest${contestCount !== 1 ? 's' : ''}`;
      }
      // Wire switcher (only once — avoid duplicate listeners by replacing the node)
      const fresh = sw.cloneNode(true);
      sw.parentNode.replaceChild(fresh, sw);
      fresh.addEventListener('change', e => {
        if (state.db) switchTournament(e.target.value); // syncs every other picker itself
      });
    }

    /**
     * Live tab's own tournament context bar — same rationale as
     * renderContestsTournamentBar above: lets an admin switch which
     * tournament's live scoring they're monitoring without leaving the tab.
     * The badge surfaces the one piece of tournament-level config actually
     * relevant here — whether matches on "Auto" resolve to the scraper or
     * CricAPI by default (see resolveMatchTrack) — so it's visible before
     * even picking a match in #matchId.
     */
    function renderLiveTournamentBar() {
      const sw    = $('#liveTournamentSwitch');
      const badge = $('#liveTournamentTrackBadge');
      if (!sw) return;
      sw.innerHTML = state.tournaments.length
        ? state.tournaments.map(t =>
            `<option value="${t.id}" ${t.id === state.activeTournamentId ? 'selected' : ''}>${escapeHtml(t.name)} (${t.format || 'T20'})</option>`
          ).join('')
        : '<option value="">— no tournaments loaded —</option>';
      if (badge) {
        const active = state.tournaments.find(t => t.id === state.activeTournamentId);
        badge.textContent = active
          ? (active.scraper_enabled ? '🕷 Scraper by default' : '📡 CricAPI by default')
          : '';
      }
      // Wire switcher (only once — avoid duplicate listeners by replacing the node)
      const fresh = sw.cloneNode(true);
      sw.parentNode.replaceChild(fresh, sw);
      fresh.addEventListener('change', e => {
        if (state.db) switchTournament(e.target.value); // syncs every other picker itself
      });
    }

    async function renderContestsAdmin() {
      const wrap = $('#adminContestsList');
      if (!state.db) {
        renderContestsTournamentBar(null);
        wrap.innerHTML = '<div class="msg warn" style="margin:10px 0;">Connect a database in the Tournament tab first.</div>';
        return;
      }
      wrap.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:6px 0;">Loading…</div>';
      try {
        const contests = await state.db.getContests(state.activeTournamentId);

        renderContestsTournamentBar(contests.length);

        if (!contests.length) {
          wrap.innerHTML = renderNewContestForm(true);
          wireNewContestForm();
          return;
        }

        // Once any match in this tournament has gone live or finished, the
        // season-long contest's settings (transfer budget, phase numbers,
        // boosters) get locked — changing them mid-season would retroactively
        // break scoring/transfer math for teams already picked. Mirrors
        // isTournamentStarted() in index.html, but scoped to whichever
        // tournament is selected in this tab's dropdown (which can differ
        // from the app's globally active tournament).
        const tournamentMatches = state.activeTournamentId
          ? await state.db.listMatches(state.activeTournamentId).catch(() => [])
          : [];
        const tournamentStarted = tournamentMatches.some(m => m.status === 'in_progress' || m.status === 'completed');

        // Helper: labelled number row (no per-row button — one Save covers the whole card)
        const numRow = (label, hint, id, val, placeholder, disabled) => `
          <div style="display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:10px;">
            <label style="font-size:12px; color:var(--muted); min-width:200px;">
              ${label}
              <div style="font-size:10px; color:var(--muted); margin-top:2px;">${hint}</div>
            </label>
            <input type="number" min="0" step="1"
              id="${id}"
              value="${val}"
              placeholder="${placeholder}"
              ${disabled ? 'disabled' : ''}
              style="width:100px; font-size:13px; padding:5px 8px;"
            />
          </div>`;

        const publicContests  = contests.filter(c => !c.is_private);
        const privateLeagues  = contests.filter(c => c.is_private);

        wrap.innerHTML = publicContests.map(c => {
          const isSL = c.contest_type === 'season_long';
          const budget        = c.total_transfers_allowed     ?? '';
          const startMN       = c.start_match_number          ?? '';
          const playoffStartMN= c.playoff_start_match_number  ?? '';
          const playoffBudget = c.playoff_transfers_allowed   ?? '';
          const playoffFirstUnlimited = !!c.playoff_first_match_unlimited;
          const locked = isSL && tournamentStarted;
          return `
            <div style="border:1px solid var(--border); border-radius:8px; padding:14px 16px; margin-bottom:12px;">
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                <strong style="font-size:14px;">${escapeHtml(c.name)}</strong>
                <span style="font-size:11px; color:var(--muted); background:var(--panel-2); padding:2px 7px; border-radius:10px;">${c.contest_type}</span>
                ${locked ? `<span style="font-size:11px; color:var(--bad);">🔒 Locked — tournament has started</span>` : ''}
              </div>
              ${isSL ? `
                ${locked ? `<div style="font-size:11px; color:var(--muted); margin-bottom:10px;">Settings below are read-only now that matches are underway — changing transfer budgets or phase numbers mid-season would break scoring for teams already picked.</div>` : ''}
                ${numRow('Season transfer budget','Total player changes allowed across the whole season. Leave blank for unlimited.',`xferBudget_${c.id}`,budget,'Unlimited',locked)}
                <div style="border-top:1px solid var(--border); margin:8px 0 12px;"></div>
                ${numRow('Season start match number','Season-long scoring and transfers only apply from this match number onward. Leave blank to include all matches.',`startMN_${c.id}`,startMN,'All matches',locked)}
                ${numRow('Playoff start match number','Match number where the playoff phase begins (uses a separate transfer budget). Leave blank if no playoff phase.',`playoffStartMN_${c.id}`,playoffStartMN,'No playoffs',locked)}
                ${numRow('Playoff transfer budget','Separate transfer allowance for the playoff phase. Leave blank for unlimited playoff transfers.',`playoffBudget_${c.id}`,playoffBudget,'Unlimited',locked)}
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
                  <label style="font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; min-width:200px;">
                    <input type="checkbox" id="playoffFirstUnlimited_${c.id}" ${playoffFirstUnlimited ? 'checked' : ''} ${locked ? 'disabled' : ''} />
                    First playoff match unlimited
                    <span style="font-size:10px; display:block;">(excludes it from the playoff budget above — the rest of the playoff matches share that budget)</span>
                  </label>
                </div>
                ${buildBoosterConfigHtml(c.id, c.available_boosters, { showSaveButton: false, disabled: locked })}
                ${!locked ? `
                <div style="display:flex; align-items:center; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border);">
                  <button class="primary contest-save-btn" data-contest="${c.id}" style="font-size:13px; padding:6px 16px;">Save contest settings</button>
                  <span class="contest-save-status" data-contest="${c.id}" style="font-size:11px; color:var(--muted);"></span>
                </div>` : ''}
              ` : `<div style="font-size:12px;color:var(--muted);">No configurable options for daily contests.</div>`}
            </div>`;
        }).join('') +

        // ── Private Leagues section ───────────────────────────────────────────
        `<div style="border-top:2px solid var(--border); margin:16px 0 12px; padding-top:14px;">
          <div style="font-size:13px; font-weight:600; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
            🔒 Private Leagues
            <span style="font-size:11px; font-weight:400; color:var(--muted);">invite-only · custom scoring · separate leaderboard</span>
          </div>

          ${await (async () => {
            if (!privateLeagues.length) return `<div style="font-size:12px; color:var(--muted); padding:8px 0;">No private leagues yet.</div>`;
            // Fetch live member counts for all private leagues in one query
            const memberCounts = await state.db.getMemberCountsForContests(privateLeagues.map(c => c.id)).catch(() => ({}));
            return privateLeagues.map(c => {
              const hasCustomRules    = c.scoring_rules     && Object.keys(c.scoring_rules).length     > 0;
              const hasCustomBoosters = c.available_boosters && Object.keys(c.available_boosters).length > 0;
              // Mirrors isSharedXI() in index.html exactly. A league with
              // neither override is a "standard" league — every member's
              // XI, boosters, and transfers are mirrored live from their own
              // main Season Long squad (db.js propagateXIToSharedSquads /
              // lock-matches). There's nothing contest-specific to configure
              // here beyond the member cap: boosters aren't a second,
              // independently-tracked pool for a standard league — setting
              // them here wouldn't even take effect for existing members,
              // since migration_v49's trigger resolves a shared squad's
              // booster availability through its PRIMARY squad's contest,
              // ignoring whatever's set on this one. Showing an editable
              // booster grid here was misleading (and, if saved, would
              // quietly reclassify the league for any NEW joiner from
              // "standard/shared" to "independent" without touching existing
              // members at all — a split-personality league).
              const isStandard     = !hasCustomRules && !hasCustomBoosters;
              const memberCount    = memberCounts[c.id] ?? 0;
              const cap            = c.max_members;
              const capDisplay     = cap ? `${memberCount} / ${cap}` : `${memberCount} members`;
              const capFull        = cap && memberCount >= cap;
              return `
              <div style="border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin-bottom:10px; background:rgba(34,211,238,0.04);">
                <!-- Header row: name + badges + invite code -->
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <strong style="font-size:13px;">${escapeHtml(c.name)}</strong>
                    ${isStandard
                      ? `<span style="font-size:10px; background:rgba(120,120,120,0.15); color:var(--muted); padding:2px 6px; border-radius:8px;">standard — mirrors Season Long</span>`
                      : `<span style="font-size:10px; background:rgba(166,124,0,0.15); color:var(--accent-2); padding:2px 6px; border-radius:8px;">custom rules</span>`}
                    <span style="font-size:11px; color:${capFull ? 'var(--bad)' : 'var(--muted)'};">${capDisplay}${capFull ? ' · full' : ''}</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:12px; color:var(--muted);">Invite code:</span>
                    <code style="font-size:14px; font-weight:700; color:var(--accent); background:var(--panel-2); padding:3px 10px; border-radius:6px; letter-spacing:2px;">${escapeHtml(c.invite_code || '—')}</code>
                    <button class="copy-invite-btn" data-code="${escapeHtml(c.invite_code || '')}" style="font-size:11px; padding:3px 8px;">Copy</button>
                    <button class="pl-delete-btn" data-contest="${c.id}" data-name="${escapeHtml(c.name)}" data-members="${memberCount}"
                      style="font-size:11px; padding:3px 8px; color:var(--bad); border-color:var(--bad); background:transparent;">Delete</button>
                  </div>
                </div>
                <!-- Scoring info -->
                <div style="font-size:11px; color:var(--muted); margin-top:6px;">
                  ${hasCustomRules ? `Custom scoring: ${Object.keys(c.scoring_rules).join(', ')} format(s) overridden` : 'Uses tournament scoring rules'}
                </div>
                <!-- Admin: editable member cap — the one thing admin controls for every private league, standard or custom -->
                <div style="display:flex; align-items:center; gap:8px; margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
                  <span style="font-size:12px; color:var(--muted); flex-shrink:0;">Member cap:</span>
                  <input type="number" min="2" max="500"
                    class="pl-cap-input"
                    data-contest="${c.id}"
                    value="${cap ?? ''}"
                    placeholder="Unlimited"
                    style="width:100px; font-size:13px; padding:4px 8px;" />
                  <button class="primary pl-cap-save" data-contest="${c.id}" style="font-size:12px; padding:4px 10px;">Save</button>
                  <span class="pl-cap-status" data-contest="${c.id}" style="font-size:11px; color:var(--muted);"></span>
                </div>
                ${isStandard
                  ? `<div style="font-size:11px; color:var(--muted); margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
                       Standard league — every member's XI, boosters, and transfers mirror their own main Season Long squad automatically. Nothing to configure here besides the member cap above; boosters/scoring follow the main Season Long contest, not a per-league setting.
                     </div>`
                  : buildBoosterConfigHtml(c.id, c.available_boosters)}
              </div>`;
            }).join('');
          })()}

          <!-- New Private League form -->
          <div style="border:1px dashed var(--border); border-radius:8px; padding:12px 14px; margin-top:8px;">
            <div style="font-size:12px; font-weight:600; color:var(--accent); margin-bottom:10px;">+ New Private League</div>
            <div style="display:flex; flex-direction:column; gap:8px;">
              <input id="plName" type="text" placeholder="League name (e.g. The Office League)" style="font-size:13px;" />
              <div style="display:flex; gap:6px; align-items:center;">
                <input id="plMaxMembers" type="number" min="2" max="100" placeholder="Max members (optional)" style="font-size:13px; flex:1;" />
              </div>

              <!-- Follow standard SL rules: Y/N — the UI represents the choice directly
                   instead of deriving "standard vs custom" from whether other fields
                   happen to be empty. Y = today's minimal form. N reveals cap, booster,
                   and scoring options in that order, mirroring the main SL contest's own
                   fields (see numRow usage on the public-contest card above). -->
              <div style="border:1px solid var(--border); border-radius:6px; padding:10px; margin-top:2px;">
                <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--muted);">Follow standard Season Long rules?</div>
                <div style="display:flex; gap:16px; flex-wrap:wrap;">
                  <label style="font-size:12px; display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="radio" name="plStandard" id="plStandardYes" value="Y" checked />
                    Yes — mirrors the main Season Long contest (transfers, boosters, scoring). Just a name and member cap.
                  </label>
                  <label style="font-size:12px; display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="radio" name="plStandard" id="plStandardNo" value="N" />
                    No — this league gets its own transfer caps, boosters, and scoring.
                  </label>
                </div>
              </div>

              <!-- Custom league options — shown only when "No" is selected -->
              <div id="plCustomSection" style="display:none; flex-direction:column; gap:8px;">
                <!-- Transfer / phase caps -->
                <div style="border:1px solid var(--border); border-radius:6px; padding:10px; margin-top:2px;">
                  <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--muted);">🔁 Transfer &amp; phase caps</div>
                  ${numRow('Season transfer budget','Total player changes allowed across the whole season. Leave blank for unlimited.','plXferBudget','','Unlimited',false)}
                  ${numRow('Season start match number','Season-long scoring and transfers only apply from this match number onward. Leave blank to include all matches.','plStartMN','','All matches',false)}
                  ${numRow('Playoff start match number','Match number where the playoff phase begins (uses a separate transfer budget). Leave blank if no playoff phase.','plPlayoffStartMN','','No playoffs',false)}
                  ${numRow('Playoff transfer budget','Separate transfer allowance for the playoff phase. Leave blank for unlimited playoff transfers.','plPlayoffBudget','','Unlimited',false)}
                  <label style="font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" id="plPlayoffFirstUnlimited" checked />
                    First playoff match unlimited
                    <span style="font-size:10px;">(excludes it from the playoff budget above — the rest of the playoff matches share that budget)</span>
                  </label>
                </div>

                <!-- Boosters for new league -->
                <div style="border:1px solid var(--border); border-radius:6px; padding:10px; margin-top:2px;">
                  <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--muted);">⚡ Boosters <span style="font-weight:400;">(check to enable, set how many uses each member gets)</span></div>
                  <div id="plBoostersGrid">
                    ${Object.entries(BOOSTER_META).map(([key, rawMeta]) => { const meta = getBoosterMeta ? (getBoosterMeta(key) ?? rawMeta) : rawMeta; return `
                      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);">
                        <input type="checkbox" id="plBoost_${key}" data-booster="${key}" class="pl-new-boost-chk" style="flex-shrink:0;" />
                        <label for="plBoost_${key}" style="font-size:12px;flex:1;cursor:pointer;">
                          ${iconHtml ? iconHtml(meta.icon, meta.label) : meta.icon} <strong>${meta.label}</strong>
                          <span style="color:var(--muted);font-size:11px;margin-left:4px;">${meta.desc}</span>
                        </label>
                        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                          <span style="font-size:11px;color:var(--muted);">Uses:</span>
                          <input type="number" min="1" max="10" value="1" id="plBoost_${key}_count"
                            style="width:50px;font-size:12px;padding:3px 6px;" disabled />
                        </div>
                      </div>`; }).join('')}
                  </div>
                </div>

                <!-- Scoring rules for new league -->
                <div style="border:1px solid var(--border); border-radius:6px; padding:10px; margin-top:2px;">
                  <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--muted);">📊 Scoring rules <span style="font-weight:400;">(overrides tournament defaults for this league only — leave unchanged to inherit them)</span></div>
                  <div class="rules-tabs" style="margin-bottom:10px;" id="plRulesTabs">
                    <span class="tab active" data-plfmt="T20">T20</span>
                    <span class="tab" data-plfmt="ODI">ODI</span>
                    <span class="tab" data-plfmt="TEST">Test</span>
                  </div>
                  <div id="plRulesEditor"></div>
                </div>
              </div>

              <button id="plCreateBtn" class="primary" style="align-self:flex-start; font-size:12px; padding:6px 14px;">Create league</button>
              <span id="plStatus" style="font-size:11px; color:var(--muted);"></span>
            </div>
          </div>
        </div>

        ${renderNewContestForm(false)}`;

        wireNewContestForm();

        // ── Wire "Save" buttons ────────────────────────────────────────────────

        // Helper: parse an int-or-null input value
        const parseIntOrNull = raw => (raw.trim() === '' ? null : parseInt(raw, 10));

        // Season-long contest settings — one Save button per card covers transfer
        // budget, phase numbers, the playoff-first-unlimited checkbox, and boosters
        // together (previously five separate buttons; consolidated since these are
        // all "set once before the season starts" values, not independent knobs).
        // Only rendered at all when the tournament hasn't started yet — see the
        // `locked` check in the card markup above — so this handler only ever runs
        // pre-season.
        wrap.querySelectorAll('.contest-save-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const cid       = btn.dataset.contest;
            const statusEl  = wrap.querySelector(`.contest-save-status[data-contest="${cid}"]`);
            const readInt   = id => {
              const raw = ($(`#${id}`)?.value ?? '').trim();
              return { raw, val: parseIntOrNull(raw) };
            };

            const budget         = readInt(`xferBudget_${cid}`);
            const startMN        = readInt(`startMN_${cid}`);
            const playoffStartMN = readInt(`playoffStartMN_${cid}`);
            const playoffBudget  = readInt(`playoffBudget_${cid}`);
            const playoffFirstUnlimited = !!$(`#playoffFirstUnlimited_${cid}`)?.checked;

            for (const [label, f] of [['Season transfer budget', budget], ['Season start match number', startMN], ['Playoff start match number', playoffStartMN], ['Playoff transfer budget', playoffBudget]]) {
              if (f.raw !== '' && (isNaN(f.val) || f.val < 0)) {
                statusEl.textContent = `${label}: enter a whole number ≥ 0, or leave blank.`;
                statusEl.style.color = 'var(--bad)'; return;
              }
            }

            // Collect booster grid (same shape as the standalone boost-save-btn handler below)
            const gridId = `boostGrid_${cid.replace(/-/g,'')}`;
            const grid    = wrap.querySelector(`#${gridId}`);
            const boosters = {};
            grid?.querySelectorAll('.boost-chk').forEach(chk => {
              if (chk.checked) {
                const key      = chk.dataset.booster;
                const countInp = chk.closest('div').querySelector('input[type="number"]');
                const count    = parseInt(countInp?.value || '1', 10);
                boosters[key]  = Number.isFinite(count) && count >= 1 ? count : 1;
              }
            });
            const boosterPayload = Object.keys(boosters).length ? boosters : null;

            btn.disabled = true; statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--muted)';
            try {
              await state.db.updateContestTransferBudget(cid, budget.val);
              await state.db.updateContestPhases(cid, {
                start_match_number: startMN.val,
                playoff_start_match_number: playoffStartMN.val,
                playoff_transfers_allowed: playoffBudget.val,
                playoff_first_match_unlimited: playoffFirstUnlimited,
              });
              await state.db.updateContestBoosters(cid, boosterPayload);

              // Keep in-memory state in sync so XI/live tabs reflect the new config immediately
              if (state.sl.seasonContest?.id === cid) {
                Object.assign(state.sl.seasonContest, {
                  total_transfers_allowed: budget.val,
                  start_match_number: startMN.val,
                  playoff_start_match_number: playoffStartMN.val,
                  playoff_transfers_allowed: playoffBudget.val,
                  playoff_first_match_unlimited: playoffFirstUnlimited,
                  available_boosters: boosterPayload,
                });
                renderSlXiTab(); renderSlLiveTab();
              }
              const mc = state.sl.contests?.find(x => x.id === cid);
              if (mc) mc.available_boosters = boosterPayload;

              statusEl.textContent = '✓ Saved.';
              statusEl.style.color = 'var(--good,#4ade80)';
            } catch (e) {
              statusEl.textContent = 'Save failed: ' + e.message;
              statusEl.style.color = 'var(--bad)';
            } finally { btn.disabled = false; }
          });
        });

        // ── Copy invite code buttons ──────────────────────────────────────────
        wrap.querySelectorAll('.copy-invite-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            navigator.clipboard?.writeText(btn.dataset.code).catch(() => {});
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
          });
        });

        // ── Member cap save buttons ───────────────────────────────────────────
        wrap.querySelectorAll('.pl-cap-save').forEach(btn => {
          btn.addEventListener('click', async () => {
            const contestId = btn.dataset.contest;
            const inp       = wrap.querySelector(`.pl-cap-input[data-contest="${contestId}"]`);
            const statusEl  = wrap.querySelector(`.pl-cap-status[data-contest="${contestId}"]`);
            const raw       = inp?.value.trim() ?? '';
            const val       = raw === '' ? null : parseInt(raw, 10);
            if (raw !== '' && (!Number.isFinite(val) || val < 2)) {
              statusEl.textContent = 'Enter a number ≥ 2, or leave blank to remove cap.';
              statusEl.style.color = 'var(--bad)'; return;
            }
            btn.disabled = true; statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--muted)';
            try {
              await state.db.updateContestMaxMembers(contestId, val);
              statusEl.textContent = val === null ? 'Cap removed.' : `Cap set to ${val}.`;
              statusEl.style.color = 'var(--good,#4ade80)';
              // Update in-memory contests list
              const c = state.sl.contests?.find(x => x.id === contestId);
              if (c) c.max_members = val;
            } catch (e) {
              statusEl.textContent = 'Save failed: ' + e.message;
              statusEl.style.color = 'var(--bad)';
            } finally { btn.disabled = false; }
          });
        });

        // ── Delete private league ─────────────────────────────────────────────
        // Irreversible — deletes every member squad in the league (XI, scores,
        // boosters, transfers all cascade with it) and the contest row itself.
        // See db.js's deletePrivateLeague / migration_v52.
        wrap.querySelectorAll('.pl-delete-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const contestId = btn.dataset.contest;
            const name       = btn.dataset.name || 'this league';
            const memberCount = parseInt(btn.dataset.members, 10) || 0;
            const warn = memberCount > 0
              ? `Delete "${name}"? This removes ${memberCount} member squad${memberCount === 1 ? '' : 's'} — their XI, scores, boosters, and transfers for this league — permanently. This cannot be undone.`
              : `Delete "${name}"? This cannot be undone.`;
            if (!confirm(warn)) return;
            btn.disabled = true;
            const originalText = btn.textContent;
            btn.textContent = 'Deleting…';
            try {
              await state.db.deletePrivateLeague(contestId);
              toast(`"${name}" deleted.`, 3000);
              await renderContestsAdmin();
            } catch (e) {
              toast('Delete failed: ' + e.message, 4000);
              btn.disabled = false;
              btn.textContent = originalText;
            }
          });
        });

        // ── Booster checkbox → enable/disable count input ─────────────────────
        wrap.querySelectorAll('.boost-chk').forEach(chk => {
          chk.addEventListener('change', () => {
            // Find sibling count input (same parent div)
            const countInp = chk.closest('div').querySelector('input[type="number"]');
            if (countInp) countInp.disabled = !chk.checked;
          });
        });

        // ── Booster Save buttons ──────────────────────────────────────────────
        wrap.querySelectorAll('.boost-save-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const contestId = btn.dataset.contest;
            const statusEl  = wrap.querySelector(`.boost-status[data-contest="${contestId}"]`);
            const gridId    = `boostGrid_${contestId.replace(/-/g,'')}`;
            const grid      = wrap.querySelector(`#${gridId}`);
            if (!grid) return;
            // Collect enabled boosters + their counts
            const boosters = {};
            grid.querySelectorAll('.boost-chk').forEach(chk => {
              if (chk.checked) {
                const key      = chk.dataset.booster;
                const countInp = chk.closest('div').querySelector('input[type="number"]');
                const count    = parseInt(countInp?.value || '1', 10);
                boosters[key]  = Number.isFinite(count) && count >= 1 ? count : 1;
              }
            });
            btn.disabled = true; statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--muted)';
            try {
              const payload = Object.keys(boosters).length ? boosters : null;
              await state.db.updateContestBoosters(contestId, payload);
              // Update in-memory so the active contest reflects new boosters
              const mc = state.sl.contests?.find(x => x.id === contestId);
              if (mc) mc.available_boosters = payload;
              if (state.sl.seasonContest?.id === contestId) state.sl.seasonContest.available_boosters = payload;
              statusEl.textContent = payload ? `✓ Saved (${Object.keys(payload).length} booster${Object.keys(payload).length !== 1 ? 's' : ''})` : '✓ Boosters cleared.';
              statusEl.style.color = 'var(--good,#4ade80)';
            } catch (e) {
              statusEl.textContent = 'Save failed: ' + e.message; statusEl.style.color = 'var(--bad)';
            } finally { btn.disabled = false; }
          });
        });

        // ── New private league form ───────────────────────────────────────────
        // Toggle count inputs on new-league booster checkboxes
        wrap.querySelectorAll('.pl-new-boost-chk').forEach(chk => {
          chk.addEventListener('change', () => {
            const countInp = document.getElementById(`plBoost_${chk.dataset.booster}_count`);
            if (countInp) countInp.disabled = !chk.checked;
          });
        });

        // State for the new-league scoring rules (starts as a copy of current tournament rules)
        let plFmt = 'T20';
        const plRules = JSON.parse(JSON.stringify(SCORING_RULES));
        let plUseCustom = false;

        function renderPlRulesEditor() {
          const editor = $('#plRulesEditor');
          if (!editor) return;
          editor.innerHTML = buildRulesGrid(plFmt, false);
          editor.querySelectorAll('input.rule-input').forEach(inp => {
            inp.addEventListener('input', e => {
              const key = e.target.dataset.key;
              const num = parseFloat(e.target.value);
              if (Number.isFinite(num)) {
                plRules[plFmt][key] = num;
                const dv = DEFAULT_SCORING_RULES[plFmt]?.[key];
                e.target.classList.toggle('changed', Number(num) !== Number(dv));
              }
            });
          });
        }

        // "Follow standard SL rules: Y/N" toggle — the top-level choice, not a
        // derivation. Y (default) hides caps/boosters/scoring entirely: just
        // name + member cap, same as today's standard-league behavior. N
        // reveals the custom section (caps, then boosters, then scoring).
        function updatePlStandardVisibility() {
          plUseCustom = !$('#plStandardYes')?.checked;
          const section = $('#plCustomSection');
          if (section) section.style.display = plUseCustom ? 'flex' : 'none';
          if (plUseCustom) renderPlRulesEditor();
        }
        wrap.querySelectorAll('input[name="plStandard"]').forEach(r => r.addEventListener('change', updatePlStandardVisibility));
        updatePlStandardVisibility();

        wrap.querySelectorAll('#plRulesTabs .tab').forEach(t => {
          t.addEventListener('click', () => {
            plFmt = t.dataset.plfmt;
            wrap.querySelectorAll('#plRulesTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.plfmt === plFmt));
            renderPlRulesEditor();
          });
        });

        $('#plCreateBtn')?.addEventListener('click', async () => {
          const name = $('#plName')?.value.trim();
          const maxM = parseInt($('#plMaxMembers')?.value || '', 10);
          const statusEl = $('#plStatus');
          if (!name) { statusEl.textContent = 'League name is required.'; statusEl.style.color = 'var(--bad)'; return; }
          const btn = $('#plCreateBtn');
          btn.disabled = true; statusEl.textContent = 'Creating…'; statusEl.style.color = 'var(--muted)';
          try {
            const isStandard = !plUseCustom;

            // Only save formats that have at least one value changed from tournament defaults
            let scoringRules = null;
            if (!isStandard) {
              const changed = {};
              ['T20', 'ODI', 'TEST'].forEach(f => {
                const def = SCORING_RULES[f]; // current tournament rules = baseline
                const pl  = plRules[f];
                if (!def || !pl) return;
                const diff = {};
                Object.keys(pl).forEach(k => { if (Number(pl[k]) !== Number(def[k])) diff[k] = pl[k]; });
                if (Object.keys(diff).length) changed[f] = { ...def, ...diff };
              });
              if (Object.keys(changed).length) scoringRules = changed;
            }

            // Boosters and transfer/phase caps only apply to a custom league — a
            // standard league mirrors the main Season Long contest's settings, so
            // setting them here wouldn't take effect anyway (same reasoning as the
            // "standard" badge note on existing private leagues above).
            let newLeagueBoosters = null;
            let totalTransfersAllowed = null, startMatchNumber = null, playoffStartMatchNumber = null,
                playoffTransfersAllowed = null, playoffFirstMatchUnlimited = true;
            if (!isStandard) {
              const boosters = {};
              wrap.querySelectorAll('.pl-new-boost-chk').forEach(chk => {
                if (chk.checked) {
                  const key      = chk.dataset.booster;
                  const countInp = document.getElementById(`plBoost_${key}_count`);
                  const count    = parseInt(countInp?.value || '1', 10);
                  boosters[key]  = Number.isFinite(count) && count >= 1 ? count : 1;
                }
              });
              newLeagueBoosters = Object.keys(boosters).length ? boosters : null;

              totalTransfersAllowed      = parseIntOrNull($('#plXferBudget')?.value || '');
              startMatchNumber           = parseIntOrNull($('#plStartMN')?.value || '');
              playoffStartMatchNumber    = parseIntOrNull($('#plPlayoffStartMN')?.value || '');
              playoffTransfersAllowed    = parseIntOrNull($('#plPlayoffBudget')?.value || '');
              playoffFirstMatchUnlimited = !!$('#plPlayoffFirstUnlimited')?.checked;
            }

            const league = await state.db.createPrivateLeague(state.activeTournamentId, {
              name,
              scoringRules,
              maxMembers      : Number.isFinite(maxM) && maxM >= 2 ? maxM : null,
              availableBoosters: newLeagueBoosters,
              totalTransfersAllowed,
              startMatchNumber,
              playoffStartMatchNumber,
              playoffTransfersAllowed,
              playoffFirstMatchUnlimited,
            });
            statusEl.textContent = `✓ League created — invite code: ${league.invite_code}`;
            statusEl.style.color = 'var(--good,#4ade80)';
            $('#plName').value = '';
            $('#plMaxMembers').value = '';
            renderContestsAdmin(); // refresh list
          } catch (e) {
            statusEl.textContent = 'Failed: ' + e.message;
            statusEl.style.color = 'var(--bad)';
            btn.disabled = false;
          }
        });

      } catch (e) {
        wrap.innerHTML = `<div class="msg err">Failed to load contests: ${escapeHtml(e.message)}</div>`;
      }
    }

    function nextPlayerId() {
      // Pick smallest unused pNN. Must check against BOTH the currently-loaded
      // A.PLAYERS (which can be tournament-scoped — see getPlayersForTournament)
      // AND the global A.ALL_PLAYER_IDS cache, since players.id is a single global
      // namespace shared by every tournament. Checking A.PLAYERS alone can suggest
      // an id (e.g. 'p01') that's free in this tournament's subset but already
      // taken globally, which fails the insert (or silently collides).
      const used = new Set(A.PLAYERS.map(p => p.id));
      A.ALL_PLAYER_IDS.forEach(id => used.add(id));
      for (let i = 1; i < 1000; i++) {
        const id = 'p' + String(i).padStart(2, '0');
        if (!used.has(id)) return id;
      }
      return 'p' + Date.now();
    }

    function renderAdmin() {
      const term = state.adminSearch.trim().toLowerCase();
      const list = A.PLAYERS.filter(p =>
        !term || p.name.toLowerCase().includes(term) || p.team.toLowerCase().includes(term)
      );

      // Context label — show which tournament's players are loaded
      const activeTournament = state.tournaments.find(t => t.id === state.activeTournamentId);
      const tableView = $('#adminTableView');
      let labelEl = tableView?.querySelector('#playersContextLabel');
      if (tableView && !labelEl) {
        labelEl = document.createElement('div');
        labelEl.id = 'playersContextLabel';
        tableView.insertBefore(labelEl, tableView.firstChild);
      }
      if (labelEl && activeTournament) {
        const isTournament = A.playersSource === 'tournament';
        const isGlobal     = A.playersSource === 'global';
        const badge = isTournament
          ? `<span style="color:var(--accent); font-weight:600;">${escapeHtml(activeTournament.name)}</span>`
          : `<span style="color:var(--muted);">all tournaments (no players imported for ${escapeHtml(activeTournament.name)} yet)</span>`;
        labelEl.innerHTML = `
          <div style="font-size:11px; color:var(--muted); padding:6px 12px 4px;
                      font-weight:600; text-transform:uppercase; letter-spacing:0.5px;
                      border-bottom:1px solid var(--border); margin-bottom:4px;">
            Showing: ${badge}
            — ${A.PLAYERS.length} player${A.PLAYERS.length !== 1 ? 's' : ''}
            ${isGlobal ? '<span style="color:var(--accent); font-weight:400; text-transform:none; letter-spacing:0;">(import players via CSV to make this tournament-specific)</span>' : ''}
          </div>`;
      }

      $('#adminCount').textContent = `${list.length} of ${A.PLAYERS.length}`;

      const teamOpts = teamCodes().map(t => `<option value="${t}">${t}</option>`).join('');
      const roleOpts = KNOWN_ROLES.map(([v,l]) => `<option value="${v}">${l}</option>`).join('');

      // Add-row first
      const addRow = `
        <tr class="add-row" id="addPlayerRow">
          <td class="col-id">${nextPlayerId()}</td>
          <td><input data-f="name" type="text" placeholder="Player name" /></td>
          <td class="col-team"><select data-f="team">${teamOpts}</select></td>
          <td class="col-role"><select data-f="role">${roleOpts}</select></td>
          <td class="col-credits"><input data-f="credits" type="number" step="0.5" value="8.5" /></td>
          <td class="col-overseas"><input data-f="overseas" type="checkbox" /></td>
          <td class="col-actions"><button class="row-add" id="addPlayerBtn" title="Add">+</button></td>
        </tr>
      `;
      const rows = list.map(p => `
        <tr data-id="${p.id}">
          <td class="col-id">${p.id}</td>
          <td><input data-f="name" type="text" value="${escapeHtml(p.name)}" /></td>
          <td class="col-team"><select data-f="team">${teamCodes().map(t => `<option value="${t}" ${t===p.team?'selected':''}>${t}</option>`).join('')}</select></td>
          <td class="col-role"><select data-f="role">${KNOWN_ROLES.map(([v,l]) => `<option value="${v}" ${v===p.role?'selected':''}>${l}</option>`).join('')}</select></td>
          <td class="col-credits"><input data-f="credits" type="number" step="0.5" value="${p.credits}" /></td>
          <td class="col-overseas"><input data-f="overseas" type="checkbox" ${p.overseas?'checked':''} /></td>
          <td class="col-actions"><button class="row-del" data-act="del" title="Delete">×</button></td>
        </tr>
      `).join('');

      $('#adminTableBody').innerHTML = addRow + rows;

      // Wire add-row
      $('#addPlayerBtn').addEventListener('click', addPlayerHandler);
      // Wire edit-rows
      $('#adminTableBody').querySelectorAll('tr[data-id]').forEach(tr => {
        const id = tr.dataset.id;
        tr.querySelectorAll('input, select').forEach(el => {
          el.addEventListener('change', () => savePlayerEdit(id, tr));
          // Live-mark dirty
          el.addEventListener('input', () => el.classList.add('dirty'));
        });
        tr.querySelector('[data-act="del"]').addEventListener('click', () => deletePlayerHandler(id));
      });
    }

    async function addPlayerHandler() {
      const row = $('#addPlayerRow');
      const name = row.querySelector('[data-f="name"]').value.trim();
      const team = row.querySelector('[data-f="team"]').value;
      const role = row.querySelector('[data-f="role"]').value;
      const credits = parseFloat(row.querySelector('[data-f="credits"]').value);
      const overseas = row.querySelector('[data-f="overseas"]').checked;
      const id = row.querySelector('.col-id').textContent;

      if (!name) { toast('Name is required.'); return; }
      if (!Number.isFinite(credits) || credits < 0) { toast('Credits must be a non-negative number.'); return; }

      // Same name-collision guard as the CSV importer (buildCsvRows) — this
      // "+" row always assigns a brand-new id (nextPlayerId()), so with no
      // check here, re-typing a name that already exists (forgetting they're
      // already in the pool, a typo'd re-add, etc.) silently created a
      // second row for the same real person instead of editing the existing
      // one. This flow has no "update existing" path, so block instead of
      // just warning — point at the existing row to edit there.
      const normName = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const existingMatch = A.PLAYERS.find(p => normName(p.name) === normName(name));
      if (existingMatch) {
        toast(`"${name}" already exists (id "${existingMatch.id}", ${existingMatch.team}) — edit that row instead of adding a duplicate.`, 6000);
        return;
      }

      try {
        if (state.db) {
          const inserted = await state.db.addPlayer({ id, name, team, role, credits, overseas }, state.activeTournamentId);
          A.PLAYERS.push(inserted);
        } else {
          A.PLAYERS.push({ id, name, team, role, credits, overseas });
        }
        A.ALL_PLAYER_IDS.add(id); // keep the global uniqueness set in sync immediately, no need to wait for a refetch
        toast(`Added ${name}.`);
        renderAdmin(); renderPool(); render();
      } catch (e) { toast('Add failed: ' + e.message, 4000); }
    }

    async function savePlayerEdit(id, tr) {
      const patch = {
        name:     tr.querySelector('[data-f="name"]').value.trim(),
        team:     tr.querySelector('[data-f="team"]').value,
        role:     tr.querySelector('[data-f="role"]').value,
        credits:  parseFloat(tr.querySelector('[data-f="credits"]').value),
        overseas: tr.querySelector('[data-f="overseas"]').checked,
      };
      if (!patch.name) { toast('Name is required.'); return; }
      if (!Number.isFinite(patch.credits) || patch.credits < 0) { toast('Bad credits value.'); return; }

      try {
        if (state.db) {
          // Pass the active tournament so team/credits/overseas land in
          // tournament_players (migration_v43) instead of silently becoming
          // the new global default for every other tournament this player
          // is also in — this row edit had no such scoping before.
          const updated = await state.db.updatePlayer(id, patch, state.activeTournamentId);
          const idx = A.PLAYERS.findIndex(p => p.id === id);
          if (idx >= 0) A.PLAYERS[idx] = updated;
        } else {
          const idx = A.PLAYERS.findIndex(p => p.id === id);
          if (idx >= 0) A.PLAYERS[idx] = { ...PLAYERS[idx], ...patch };
        }
        tr.querySelectorAll('.dirty').forEach(el => el.classList.remove('dirty'));
        renderPool(); render();
      } catch (e) { toast('Save failed: ' + e.message, 4000); }
    }

    async function deletePlayerHandler(id) {
      const p = playerById(id);
      if (!confirm(`Delete ${p?.name || id}? This cannot be undone.`)) return;
      try {
        if (state.db) await state.db.deletePlayer(id);
        A.ALL_PLAYER_IDS.delete(id); // global row is actually gone (deletePlayer throws if still FK-referenced), so the id is free again
        const idx = A.PLAYERS.findIndex(x => x.id === id);
        if (idx >= 0) A.PLAYERS.splice(idx, 1);
        // Also drop from current XI if selected
        const selIdx = state.selected.indexOf(id);
        if (selIdx >= 0) {
          state.selected.splice(selIdx, 1);
          if (state.captain === id)     state.captain = null;
          if (state.viceCaptain === id) state.viceCaptain = null;
        }
        toast('Deleted.');
        renderAdmin(); renderPool(); render();
      } catch (e) { toast('Delete failed: ' + e.message, 5000); }
    }

    // ─── MATCHES ADMIN ───────────────────────────────────────────────────────
    function nextMatchNumber() {
      const used = new Set(state.matches.map(m => m.match_number).filter(Boolean));
      for (let n = 1; n < 1000; n++) if (!used.has(n)) return n;
      return state.matches.length + 1;
    }

    function renderMatchesAdmin() {
      const matches = [...state.matches].sort((a,b) => (a.match_number||0) - (b.match_number||0));
      const teamOpts = teamCodes().map(t => `<option value="${t}">${escapeHtml(t)}</option>`).join('');
      // Include a placeholder when the field is unset (NULL home/away from sync).
      const teamOptsFor = sel => {
        const isNull = sel == null || sel === '';
        const placeholder = `<option value="" ${isNull?'selected':''}>—</option>`;
        return placeholder + teamCodes().map(t => `<option value="${t}" ${t===sel?'selected':''}>${escapeHtml(t)}</option>`).join('');
      };

      // Convert ISO/Z UTC string → datetime-local input value (YYYY-MM-DDTHH:MM in LOCAL tz)
      const isoToLocalInput = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const nowDefault = isoToLocalInput(new Date().toISOString());

      const addRow = `
        <tr class="add-row" id="addMatchRow">
          <td class="col-id"><input data-f="match_number" type="number" min="1" value="${nextMatchNumber()}" style="width:50px;" /></td>
          <td class="col-team"><select data-f="home_team_id">${teamOpts}</select></td>
          <td class="col-team"><select data-f="away_team_id">${teamOpts}</select></td>
          <td class="col-role"><select data-f="format"><option value="T20">T20</option><option value="ODI">ODI</option><option value="TEST">Test</option></select></td>
          <td><input data-f="start_time" type="datetime-local" value="${nowDefault}" /></td>
          <td><select data-f="status">
            <option value="scheduled">Scheduled</option>
            <option value="delayed">🌧 Delayed</option>
            <option value="live">🔴 Live</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
          </select></td>
          <td><select data-f="match_type" style="font-size:11px;">
            <option value="">League</option>
            <option value="qualifier_1">Q1</option>
            <option value="qualifier_2">Q2</option>
            <option value="eliminator">Elim</option>
            <option value="semi_final">SF</option>
            <option value="final">Final</option>
          </select></td>
          <td><select data-f="data_source" style="font-size:11px;">
            <option value="auto" selected>Auto</option>
            <option value="cricapi">CricAPI</option>
            <option value="scraper">Scraper</option>
          </select></td>
          <td><input data-f="lock_time" type="datetime-local" /></td>
          <td class="col-actions"><button class="row-add" id="addMatchBtn" title="Add">+</button></td>
        </tr>
      `;
      // Format the user's daily XI total for this match (if any).
      // Only daily teams (squadId == null) — SL teams are scored separately.
      const xiPtsCell = m => {
        const arr = state.xiScoresByMatch?.[m.id] || [];
        if (!arr.length) return '<span style="color:var(--muted);">—</span>';
        // Filter to daily teams only (squad_id is null)
        const dailyTeam = [...state.savedTeams]
          .filter(t => t.matchId === m.id && !t.squadId)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        if (!dailyTeam) return '<span style="color:var(--muted);">—</span>';
        const chosen = arr.find(s => s.userTeamId === dailyTeam.id);
        if (!chosen) return '<span style="color:var(--muted);">—</span>';
        return `<span style="color:var(--accent); font-weight:700;">${chosen.totalPoints.toFixed(1)}</span>`;
      };

      const rows = matches.map(m => `
        <tr data-id="${m.id}">
          <td class="col-id"><input data-f="match_number" type="number" min="1" value="${m.match_number||''}" style="width:50px;" /></td>
          <td class="col-team"><select data-f="home_team_id">${teamOptsFor(m.home_team_id)}</select></td>
          <td class="col-team"><select data-f="away_team_id">${teamOptsFor(m.away_team_id)}</select></td>
          <td class="col-role"><select data-f="format">
            <option value="T20"  ${m.format==='T20'?'selected':''}>T20</option>
            <option value="ODI"  ${m.format==='ODI'?'selected':''}>ODI</option>
            <option value="TEST" ${m.format==='TEST'?'selected':''}>Test</option>
          </select></td>
          <td><input data-f="start_time" type="datetime-local" value="${isoToLocalInput(m.start_time)}" /></td>
          <td><select data-f="match_type" style="font-size:11px;">
            <option value=""        ${!m.match_type?'selected':''}>League</option>
            <option value="qualifier_1" ${m.match_type==='qualifier_1'?'selected':''}>Q1</option>
            <option value="qualifier_2" ${m.match_type==='qualifier_2'?'selected':''}>Q2</option>
            <option value="eliminator"  ${m.match_type==='eliminator'?'selected':''}>Elim</option>
            <option value="semi_final"  ${m.match_type==='semi_final'?'selected':''}>SF</option>
            <option value="final"       ${m.match_type==='final'?'selected':''}>Final</option>
          </select></td>
          <td><select data-f="data_source" style="font-size:11px;"
              title="Force this match onto a specific data source, overriding the tournament's default. Auto = inherit the tournament's Scraper Enabled setting.">
            <option value="auto"    ${(!m.data_source||m.data_source==='auto')?'selected':''}>Auto</option>
            <option value="cricapi" ${m.data_source==='cricapi'?'selected':''}>CricAPI</option>
            <option value="scraper" ${m.data_source==='scraper'?'selected':''}>Scraper</option>
          </select></td>
          <td style="white-space:nowrap;">
            ${(() => {
              const isDelayed   = m.status === 'delayed';
              const isAbandoned = m.status === 'abandoned';
              const isOver      = m.status === 'completed' || isAbandoned || m.status === 'cancelled';
              const statusLabels = {
                scheduled: '🕐 Scheduled', delayed: '🌧 Delayed',
                live: '🔴 Live', in_progress: '▶ In Progress', completed: '✓ Completed',
                abandoned: '🚫 Abandoned', cancelled: '✕ Cancelled',
              };
              const badge = statusLabels[m.status] ?? m.status ?? '—';
              const badgeColor = isDelayed ? 'var(--accent-2)'
                : m.status === 'completed' ? 'var(--good)'
                : (isAbandoned || m.status === 'cancelled') ? 'var(--bad)'
                : m.status === 'live' || m.status === 'in_progress' ? 'var(--bad)'
                : 'var(--muted)';
              // 'completed' with no stats_verified_at means this flip came from
              // the scrape-scorecard/poll-cricapi staleness-guard bypass — the
              // page's own status text said the match ended, but the stats/
              // scorecard write for that same run was skipped as untrustworthy
              // (see scrape-scorecard/index.ts step 3b, migration_v59). status
              // and the underlying scorecard can be out of sync until a
              // trustworthy (non-stale) re-scrape lands, e.g. via the row's
              // Scrape button — that always bypasses staleness for a manual
              // matchId call and will set stats_verified_at once it succeeds.
              const needsVerification = m.status === 'completed' && !m.stats_verified_at;
              // Quick time-push always targets lock_time — pushing from
              // lock_time if one's already set, otherwise from start_time as
              // the base. First use also promotes 'scheduled' → 'delayed',
              // since the lock-matches cron job only checks lock_time for
              // status='delayed' matches — pushing without that flip would
              // silently no-op.
              const canPush = !isOver && m.status !== 'live' && m.status !== 'in_progress';
              return `
                <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                  <span style="font-size:11px;font-weight:600;color:${badgeColor};">${badge}</span>
                  ${needsVerification ? `
                    <span title="Marked completed from a stale/unverified read — the scorecard behind it may be incomplete. Click Scrape to force a trustworthy re-read and verify."
                      style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;
                             background:rgba(220,80,80,0.12);border:1px solid var(--bad);color:var(--bad);cursor:help;">
                      ⚠ unverified
                    </span>` : ''}
                  <button class="delay-toggle-btn" data-id="${m.id}" data-delayed="${isDelayed}"
                    style="font-size:10px;padding:2px 7px;border-radius:4px;
                           background:${isDelayed ? 'rgba(166,124,0,0.12)' : 'transparent'};
                           border:1px solid ${isDelayed ? 'var(--accent-2)' : 'var(--border)'};
                           color:${isDelayed ? 'var(--accent-2)' : 'var(--muted)'};cursor:pointer;"
                    title="${isDelayed ? 'Remove delay — CricAPI will re-sync status' : 'Mark match as delayed (rain/other)'}"
                    ${isOver ? 'disabled' : ''}>
                    ${isDelayed ? '✕ Delayed' : '🌧 Delay'}
                  </button>
                  ${canPush ? `
                    <button class="push-time-btn" data-id="${m.id}" data-min="15" title="Push lock time +15 min"
                      style="font-size:10px;padding:2px 6px;border-radius:4px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;">+15m</button>
                    <button class="push-time-btn" data-id="${m.id}" data-min="30" title="Push lock time +30 min"
                      style="font-size:10px;padding:2px 6px;border-radius:4px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;">+30m</button>
                  ` : ''}
                  <button class="abandon-toggle-btn" data-id="${m.id}" data-abandoned="${isAbandoned}"
                    style="font-size:10px;padding:2px 7px;border-radius:4px;
                           background:${isAbandoned ? 'rgba(220,80,80,0.12)' : 'transparent'};
                           border:1px solid ${isAbandoned ? 'var(--bad)' : 'var(--border)'};
                           color:${isAbandoned ? 'var(--bad)' : 'var(--muted)'};cursor:pointer;"
                    title="${isAbandoned ? 'Revert — back to Scheduled' : 'Mark match as abandoned — it stops locking, users roll to the next match'}"
                    ${m.status === 'completed' ? 'disabled' : ''}>
                    ${isAbandoned ? '↩ Abandoned' : '🚫 Abandon'}
                  </button>
                </div>`;
            })()}
          </td>
          <td><input data-f="lock_time" type="datetime-local" value="${isoToLocalInput(m.lock_time)}" /></td>
          <td class="col-actions">
            ${(() => {
              // A match is "in play" when start_time has passed and it's not completed/delayed.
              // Admin does NOT need to manually set status to live/in_progress.
              const isPastStart = m.start_time && new Date(m.start_time) <= new Date();
              const isInPlay    = isPastStart && m.status !== 'completed' && m.status !== 'delayed'
                                   && m.status !== 'abandoned' && m.status !== 'cancelled';
              const isFinished  = m.status === 'completed';
              const matchTournament = state.tournaments?.find(t => t.id === m.tournament_id);
              // Track resolution lives in resolveMatchTrack() (top of this file) —
              // the client-side copy of the same rule poll-cricapi/index.ts and
              // scrape-scorecard/index.ts already implement server-side.
              const track = resolveMatchTrack(m, matchTournament);
              const isCricApiDriven = m.external_id && track === 'cricapi';
              // Finalize used to be gated on m.external_id alone, which assumes
              // every actionable match has a CricAPI id — scraper-tracked matches
              // identify by scorecard_url instead and usually have no external_id
              // at all, so that gate hid Finalize completely for them once
              // completed (no external_id => hidden; isInPlay => false once done;
              // Scrape => also isInPlay-only). See
              // docs/score_audit_track_streamline_plan.md §3.5.
              const hasSourceId = track === 'cricapi' ? !!m.external_id : !!m.scorecard_url;
              const finalizeTitle = track === 'cricapi'
                ? 'Fetch scorecard from CricAPI (reusing a finished-looking cache when available) &amp; save fantasy points'
                : 'Fetch scorecard from the scraper &amp; save fantasy points';
              return `
                ${(isFinished || isInPlay) && hasSourceId
                  ? `<button class="row-finalize" data-act="finalize" title="${finalizeTitle}">Finalize</button>`
                  : ''}
                ${(isFinished || isInPlay)
                  ? `<button class="row-manual-sc" data-act="manual-sc"
                       style="font-size:11px;padding:2px 7px;border-radius:4px;
                              background:rgba(160,110,220,0.10);border:1px solid rgba(160,110,220,0.45);
                              color:rgba(160,110,220,0.95);cursor:pointer;"
                       title="Paste a scorecard by hand — for when CricAPI/scraper have no data for this match, or to fix unmatched players / fielding credit directly. Scores through the same engine and shows up in the Live tab like any other match.">📋 Manual</button>`
                  : ''}
                ${isFinished
                  ? `<button class="row-fielding" data-act="fielding"
                       style="font-size:11px;padding:2px 7px;border-radius:4px;
                              background:rgba(201,168,76,0.10);border:1px solid var(--accent);
                              color:var(--accent);cursor:pointer;"
                       title="Manually add catch/stumping/run-out/bowled/LBW credit for a player in this match">🥎 Fielding</button>`
                  : ''}
                ${isFinished
                  ? `<button class="row-revert-live" data-act="revert-live"
                       style="font-size:11px;padding:2px 7px;border-radius:4px;
                              background:rgba(220,80,80,0.10);border:1px solid rgba(220,80,80,0.4);
                              color:rgba(220,80,80,0.95);cursor:pointer;"
                       title="Match got marked Completed but the scorecard isn't actually finished (bad/early signal from the data source). Set it back to In Progress so Poll/Scrape can run again.">↩ Revert to Live</button>`
                  : ''}
                ${isInPlay && isCricApiDriven
                  ? `<button class="row-poll" data-act="poll"
                       style="font-size:11px;padding:2px 7px;border-radius:4px;
                              background:rgba(80,160,255,0.10);border:1px solid rgba(80,160,255,0.4);
                              color:rgba(80,160,255,0.95);cursor:pointer;"
                       title="Poll CricAPI now — fetch scorecard, score it, write to the database (same as the cron job)">📡 Poll</button>`
                  : ''}
                ${isInPlay && track === 'scraper'
                  ? `<button class="row-scrape" data-act="scrape"
                       style="font-size:11px;padding:2px 7px;border-radius:4px;
                              background:rgba(120,200,80,0.10);border:1px solid rgba(120,200,80,0.4);
                              color:rgba(100,180,60,0.95);cursor:pointer;"
                       title="Fetch scorecard now from scraper sources">🕷 Scrape</button>
                     ${m.scorecard_url
                       ? `<span style="font-size:9px;color:var(--muted);display:block;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(m.scorecard_url ?? '')}">↳ ${escapeHtml((m.scorecard_url??'').replace('https://','').split('/')[0])}</span>`
                       : '<span style="font-size:9px;color:var(--muted);">↳ URL pending</span>'}`
                  : ''}
              `;
            })()}
            <button class="row-del" data-act="del" title="Delete">×</button>
          </td>
        </tr>
      `).join('');

      $('#adminMatchesBody').innerHTML = addRow + rows;
      $('#addMatchBtn').addEventListener('click', addMatchHandler);
      $('#adminMatchesBody').querySelectorAll('tr[data-id]').forEach(tr => {
        const id = tr.dataset.id;
        tr.querySelectorAll('input, select').forEach(el => {
          el.addEventListener('change', () => saveMatchEdit(id, tr));
          el.addEventListener('input',  () => el.classList.add('dirty'));
        });
        tr.querySelector('[data-act="del"]').addEventListener('click', () => deleteMatchHandler(id));
        tr.querySelector('[data-act="finalize"]')?.addEventListener('click', () => finalizeMatchRouted(id));
        tr.querySelector('[data-act="poll"]')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = '⏳';
          try {
            const supabaseUrl = state.db._supabaseUrl?.() ?? '';
            const anonKey     = state.db._anonKey?.() ?? '';
            const edgeFnUrl   = supabaseUrl.replace('.supabase.co', '.supabase.co/functions/v1') + '/poll-cricapi';
            const res = await fetch(edgeFnUrl, {
              method : 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
              body   : JSON.stringify({ matchId: id }),
            });
            const json = await res.json();
            if (!json.ok) throw new Error(json.error ?? 'Poll failed');
            const r = json.results?.[0];
            if (r?.status === 'ok') {
              toast(`📡 Polled CricAPI — ${r.matched} player${r.matched===1?'':'s'} scored. ` +
                `Unmatched: ${r.unmatched?.length ?? 0}.` +
                (r.matchCompleted ? ' Match completed — finalized.' : ''), 5000);
              renderMatchesAdmin();
              // Refresh whatever's currently on screen for this match
              if (state.activeMatchId === id || $('#matchId')?.value === state.matches.find(x => x.id===id)?.external_id) {
                connectLive().catch(() => {});
              }
            } else {
              toast(`Poll: ${r?.status ?? json.message ?? 'no live matches'} — ${r?.error ?? ''}`, 6000);
            }
          } catch (err) {
            toast('Poll failed: ' + err.message, 5000);
          } finally { btn.disabled = false; btn.textContent = '📡 Poll'; }
        });
        tr.querySelector('[data-act="scrape"]')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = '⏳';
          await scrapeMatchNow(id); // extracted — see scrapeMatchNow() for the full flow
          btn.disabled = false; btn.textContent = '🕷 Scrape';
        });
        tr.querySelector('[data-act="revert-live"]')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const match = state.matches.find(x => x.id === id);
          const label = match
            ? `Match ${match.match_number ?? ''} (${match.home_team_id ?? ''} vs ${match.away_team_id ?? ''})`
            : `match ${id}`;
          if (!confirm(
            `Revert ${label} from Completed back to In Progress?\n\n` +
            `Use this when the data source (CricAPI/scraper) marked the match ` +
            `completed but the scorecard shows it's still actually live — this ` +
            `re-enables Poll/Scrape for it and resets the stored progress ` +
            `watermark so the next read isn't rejected as "stale".\n\n` +
            `It does NOT delete the player_match_stats already saved — those get ` +
            `overwritten by the next Poll/Scrape/Recalc once real data comes in.\n\n` +
            `Proceed?`
          )) return;
          btn.disabled = true; btn.textContent = '…';
          try {
            const upd = await state.db.updateMatch(id, {
              status: 'in_progress', progressInnings: 0, progressBalls: 0,
            });
            const idx = state.matches.findIndex(x => x.id === id);
            if (idx >= 0) state.matches[idx] = upd;
            renderMatchesAdmin();
            toast('↩ Reverted to In Progress — Poll/Scrape are available again.', 4500);
          } catch (err) {
            toast('Revert failed: ' + err.message, 5000);
            btn.disabled = false; btn.textContent = '↩ Revert to Live';
          }
        });
        tr.querySelector('[data-act="fielding"]')?.addEventListener('click', () => toggleFieldingCreditRow(id, tr));
        tr.querySelector('[data-act="manual-sc"]')?.addEventListener('click', () => toggleManualScorecardRow(id, tr));
        tr.querySelector('.delay-toggle-btn')?.addEventListener('click', async (e) => {
          const btn       = e.currentTarget;
          const isDelayed = btn.dataset.delayed === 'true';
          // Toggle: if currently delayed → revert to scheduled (CricAPI will correct on next sync)
          //         if not delayed → mark as delayed
          const newStatus = isDelayed ? 'scheduled' : 'delayed';
          btn.disabled = true;
          try {
            await state.db.updateMatch(id, { status: newStatus });
            const m = state.matches.find(x => x.id === id);
            if (m) m.status = newStatus;
            renderMatchesAdmin(); // re-render so badge + button reflect new state
            toast(isDelayed ? 'Delay removed — CricAPI will re-sync status on next poll.' : '🌧 Match marked as delayed.');
          } catch (err) {
            toast('Failed: ' + err.message);
            btn.disabled = false;
          }
        });
        tr.querySelectorAll('.push-time-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const minutes = parseInt(btn.dataset.min, 10);
            const m = state.matches.find(x => x.id === id);
            if (!m) return;
            const base = m.lock_time || m.start_time;
            if (!base) { toast('No start time set on this match yet — set one first.'); return; }
            // Always push lockTime forward from the current effective gate —
            // never startTime. Previously this pushed startTime instead on a
            // match's first push (when lock_time wasn't set yet) while still
            // flipping status to 'delayed', and effectiveLockTime() treats a
            // delayed match with no lock_time as having NO gate at all — so
            // the row would show "no lock gate set" right after being pushed.
            const newTime = new Date(new Date(base).getTime() + minutes * 60000).toISOString();
            const patch = { lockTime: newTime };
            // First push declares the delay — the lock-matches cron job only
            // checks lock_time for status='delayed' matches, so this makes
            // sure the push doesn't just get silently ignored by it.
            if (m.status === 'scheduled') patch.status = 'delayed';
            btn.disabled = true;
            try {
              const upd = await state.db.updateMatch(id, patch);
              const idx = state.matches.findIndex(x => x.id === id);
              if (idx >= 0) state.matches[idx] = upd;
              renderMatchesAdmin();
              renderMatchSelector();
              toast(`⏱ Pushed lock time +${minutes} min for M${m.match_number ?? '?'}.`);
            } catch (err) {
              toast('Push failed: ' + err.message, 4000);
              btn.disabled = false;
            }
          });
        });
        tr.querySelector('.abandon-toggle-btn')?.addEventListener('click', async (e) => {
          const btn         = e.currentTarget;
          const isAbandoned = btn.dataset.abandoned === 'true';
          const m     = state.matches.find(x => x.id === id);
          const label = m ? `Match ${m.match_number ?? ''} (${m.home_team_id ?? ''} vs ${m.away_team_id ?? ''})` : `match ${id}`;
          if (!isAbandoned && !confirm(
            `Mark ${label} as abandoned?\n\n` +
            `This match will no longer lock — users currently on it will ` +
            `automatically roll to the next scheduled match instead.\n\nProceed?`
          )) return;
          const newStatus = isAbandoned ? 'scheduled' : 'abandoned';
          btn.disabled = true;
          try {
            const upd = await state.db.updateMatch(id, { status: newStatus });
            const idx = state.matches.findIndex(x => x.id === id);
            if (idx >= 0) state.matches[idx] = upd;
            renderMatchesAdmin();
            renderMatchSelector();
            toast(isAbandoned ? 'Un-abandoned — back to Scheduled.' : '🚫 Match marked abandoned.');
          } catch (err) {
            toast('Failed: ' + err.message, 4000);
            btn.disabled = false;
          }
        });
      });
      $('#adminCount').textContent = `${matches.length} matches`;
    }

    // Manual fielding/wicket-bonus credit — fully free-form entry, independent of
    // any parsed dismissal. Covers all 6 categories the admin can credit for a
    // completed match: catch, stumping, run-out (direct/assist), bowled bonus,
    // LBW bonus. Always writes source='scraper_manual', which both the scraper's
    // regression guard and any future re-scrape treat as permanently protected.
    const MANUAL_FIELDING_RULE_KEY = {
      catches: 'catch', stumpings: 'stumping',
      runOutDirect: 'run_out_direct', runOutIndirect: 'run_out_indirect',
      bowled: 'lbw_bowled_bonus', lbw: 'lbw_bowled_bonus',
    };
    const MANUAL_FIELDING_LABELS = {
      catches: 'Catch', stumpings: 'Stumping',
      runOutDirect: 'Run-out (direct)', runOutIndirect: 'Run-out (assist)',
      bowled: 'Bowled (bonus)', lbw: 'LBW (bonus)',
    };

    async function toggleFieldingCreditRow(matchId, tr) {
      const existing = tr.parentElement?.querySelector(`.fielding-credit-row[data-matchid="${matchId}"]`);
      if (existing) { existing.remove(); return; }
      // Only one inline credit form open at a time.
      $('#adminMatchesBody')?.querySelectorAll('.fielding-credit-row').forEach(r => r.remove());

      const m = state.matches.find(x => x.id === matchId);
      if (!m) return;

      const formRow = document.createElement('tr');
      formRow.className = 'fielding-credit-row';
      formRow.dataset.matchid = matchId;
      formRow.innerHTML = `
        <td colspan="10" style="padding:8px 10px; background:rgba(201,168,76,0.06); border-top:1px dashed var(--accent);">
          <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">Loading players…</div>
        </td>`;
      tr.after(formRow);

      try {
        const tPlayers = m.tournament_id ? await state.db.getPlayersForTournament(m.tournament_id) : [];
        const rosterPlayers = tPlayers.filter(p => p.team === m.home_team_id || p.team === m.away_team_id);
        const pool = rosterPlayers.length ? rosterPlayers : tPlayers;
        const playerOpts = pool.map(p =>
          `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.role}${p.overseas ? ', ✈️' : ''})</option>`
        ).join('');
        const fieldOpts = Object.entries(MANUAL_FIELDING_LABELS).map(
          ([k, label]) => `<option value="${k}">${label}</option>`
        ).join('');

        formRow.querySelector('td').innerHTML = `
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; font-size:11px;">
            <span style="font-weight:600; color:var(--accent);">🥎 Manual credit:</span>
            <select class="mfc-player" style="font-size:11px; max-width:200px;">
              <option value="">— select player —</option>
              ${playerOpts}
            </select>
            <select class="mfc-field" style="font-size:11px;">${fieldOpts}</select>
            <input class="mfc-count" type="number" min="1" step="1" value="1" style="width:48px; font-size:11px;" />
            <button class="mfc-save"
              style="font-size:10px; padding:2px 8px; border-radius:4px; background:rgba(201,168,76,0.15);
                     border:1px solid var(--accent); color:var(--accent); cursor:pointer;">Save</button>
            <button class="mfc-cancel"
              style="font-size:10px; padding:2px 8px; border-radius:4px; background:transparent;
                     border:1px solid var(--border); color:var(--muted); cursor:pointer;">Cancel</button>
            <span class="mfc-status" style="font-size:10px; color:var(--muted);"></span>
          </div>`;

        formRow.querySelector('.mfc-cancel').addEventListener('click', () => formRow.remove());
        formRow.querySelector('.mfc-save').addEventListener('click', async (e) => {
          const btn       = e.currentTarget;
          const playerId  = formRow.querySelector('.mfc-player').value;
          const field     = formRow.querySelector('.mfc-field').value;
          const count     = Math.max(1, parseInt(formRow.querySelector('.mfc-count').value, 10) || 1);
          const statusEl  = formRow.querySelector('.mfc-status');
          if (!playerId) { statusEl.textContent = 'Select a player first.'; return; }

          btn.disabled = true; statusEl.textContent = 'Saving…';
          try {
            const overrides = await state.db.getScoringRules(m.tournament_id).catch(() => ({}));
            const fmt   = m.format || 'T20';
            const rules = { ...DEFAULT_SCORING_RULES[fmt], ...(overrides?.[fmt] || {}) };
            const ruleKey = MANUAL_FIELDING_RULE_KEY[field];
            const points  = count * (rules[ruleKey] || 0);

            await state.db.applyManualFieldingCredit(matchId, playerId, field, count, points);
            await computeAndSaveXIScoresForMatch(matchId);
            await computeAndSaveSLScoresForMatch(matchId);

            const playerName = pool.find(p => p.id === playerId)?.name || playerId;
            toast(`🥎 Credited ${playerName}: ${count}× ${MANUAL_FIELDING_LABELS[field]} (+${points} pts). Propagated to XI/SL totals.`, 5000);
            formRow.remove();
          } catch (err) {
            statusEl.textContent = 'Failed: ' + err.message;
            btn.disabled = false;
          }
        });
      } catch (err) {
        formRow.querySelector('td').innerHTML =
          `<span style="font-size:11px; color:var(--bad);">Failed to load players: ${escapeHtml(err.message)}</span>`;
      }
    }


    // ─── MANUAL SCORECARD ENTRY ─────────────────────────────────────────────
    // Fallback path for when NEITHER CricAPI nor the scraper has a match's
    // data (source outage, a fixture neither provider carries, a scorecard
    // an admin only has as a spreadsheet/photo/etc). An admin pastes the
    // scorecard (tab-separated — i.e. copied straight out of Excel/Sheets)
    // in the same shape CricketAddictor/ESPN scorecards already use: a team
    // name header, a "Batting" block, a "Bowling" block (that innings'
    // BOWLING TEAM's figures — standard scorecard convention), repeated for
    // the second innings.
    //
    // The parsed result is deliberately built in the exact shape CricAPI's
    // own match_scorecard payload uses (batter/bowler objects, r/b/4s/6s,
    // dismissal-text, o/m/r/w/dots/wd/nb) and fed through the SAME
    // fromCricAPI() → mergeApiPlayersByLocalId() → calculateScore() pipeline
    // a live CricAPI connection already uses. That's what makes this behave
    // "like any other match" afterwards: unmatched-name Link, fielding-issue
    // surfacing, Rescore, the Live tab's raw scorecard and Fantasy Scorecard
    // panels — all of it is the existing machinery, not a parallel one.

    function _msSplitCells(line) {
      if (line.indexOf('\t') !== -1) return line.split('\t');
      // Fallback for a paste that lost its tabs (e.g. re-typed by hand) —
      // treat 2+ spaces as a column break.
      return line.split(/ {2,}/);
    }
    function _msClean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
    function _msStripMarkers(name) {
      // "(c)", "(vc)", captain/keeper markers — never part of a real name.
      return _msClean(String(name ?? '').replace(/\(c\)/gi, '').replace(/\(vc\)/gi, '').replace(/[†‡]/g, ''));
    }
    const MS_BAT_HEADER_MAP = { 'R': 'r', 'B': 'b', '4S': '4s', '6S': '6s' }; // SR/M ignored — recomputed / not scored
    const MS_BOWL_HEADER_MAP = { 'O': 'o', 'M': 'm', 'R': 'r', 'W': 'w', '0S': 'dots', 'DOTS': 'dots', 'WD': 'wd', 'NB': 'nb' }; // ECON ignored — derived


    /** Lazily inject the SheetJS (xlsx) library — only when an admin actually
     * uses the Manual Scorecard's "Upload Excel" option, so ordinary sessions
     * never pay for it. Mirrors loadAdminModule()'s lazy-inject-once pattern
     * in index.html, and the jsdelivr→unpkg fallback used for the Supabase SDK. */
    function loadXlsxLib() {
      return new Promise((resolve, reject) => {
        if (window.XLSX) { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload = resolve;
        s.onerror = () => {
          const s2 = document.createElement('script');
          s2.src = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js';
          s2.onload = resolve;
          s2.onerror = () => reject(new Error('Could not load the Excel-reading library (jsdelivr and unpkg both blocked/unreachable) — paste the scorecard as text instead.'));
          document.head.appendChild(s2);
        };
        document.head.appendChild(s);
      });
    }

    /** Converts every sheet of an uploaded workbook into the same tab-separated
     * text parseManualScorecardPaste() already expects from a clipboard paste —
     * one parser, whichever way the data came in. Blank rows are preserved
     * (they're what tells the parser where one section/innings ends). */
    function xlsxWorkbookToPasteText(wb) {
      return wb.SheetNames
        .map(name => XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: '\t', blankrows: true }))
        .join('\n\n');
    }

    /**
     * Parses a pasted scorecard into a CricAPI-shaped payload:
     * { data: { matchInfo: {name}, status, scorecard: [ {inning, r, w, o, batting:[...], bowling:[...]} ] } }
     * Throws with a human-readable message if nothing parseable was found.
     */
    function parseManualScorecardPaste(text, matchLabel) {
      const lines = String(text || '').replace(/\r/g, '').split('\n');
      const innings = [];
      let cur = null;              // current innings block
      let section = null;          // 'batting' | 'bowling' | null
      let battingCols = null;      // header cells from the "Batting" row, index-aligned (index 0/1 reserved for name/dismissal)
      let bowlingCols = null;      // header cells from the "Bowling" row, index-aligned (index 0 reserved for name)

      for (const raw of lines) {
        const cells = _msSplitCells(raw).map(_msClean);
        const nonEmpty = cells.filter(Boolean);
        if (!nonEmpty.length) { section = null; continue; } // blank line ends whatever section we were in

        const first = cells[0] || '';
        const restEmpty = cells.slice(1).every(c => !c);

        if (/^(batting)$/i.test(first)) { section = 'batting'; battingCols = cells; continue; }
        if (/^(bowling)$/i.test(first)) { section = 'bowling'; bowlingCols = cells; continue; }
        if (/^(extras)$/i.test(first)) {
          if (cur) { const n = nonEmpty.slice(1).map(v => parseInt(v, 10)).find(v => Number.isFinite(v)); cur._extras = n || 0; }
          continue;
        }
        if (/^(total)$/i.test(first)) {
          if (cur) {
            const joined = nonEmpty.join(' ');
            const rw = joined.match(/(\d+)\s*\/\s*(\d+)/);
            const ov = joined.match(/(\d+(?:\.\d+)?)\s*(?:ov|overs)?/i);
            if (rw) { cur.r = parseInt(rw[1], 10); cur.w = parseInt(rw[2], 10); }
            if (ov) cur.o = ov[1];
          }
          continue;
        }
        if (/^(did not bat|yet to bat|dnb)/i.test(first)) { continue; }

        if (restEmpty && !section) {
          // A bare name with nothing else on the line, outside any section,
          // and not "Batting"/"Bowling"/"Extras"/"Total" — treat as a team
          // header, starting a new innings block.
          cur = { inning: first, r: null, w: null, o: null, batting: [], bowling: [], _extras: 0 };
          innings.push(cur);
          section = null; battingCols = null; bowlingCols = null;
          continue;
        }

        if (!cur) continue; // stray line before any team header — ignore
        if (section === 'batting') {
          const name = _msStripMarkers(cells[0]);
          if (!name) continue;
          const dismissalText = _msClean(cells[1]) || 'not out';
          const row = { batter: { name }, r: 0, b: 0, '4s': 0, '6s': 0, 'dismissal-text': dismissalText };
          for (let i = 2; i < cells.length; i++) {
            const key = MS_BAT_HEADER_MAP[(battingCols?.[i] || '').toUpperCase()];
            if (key && cells[i] !== '') row[key] = parseFloat(cells[i]) || 0;
          }
          cur.batting.push(row);
        } else if (section === 'bowling') {
          const name = _msStripMarkers(cells[0]);
          if (!name) continue;
          const row = { bowler: { name }, o: 0, m: 0, r: 0, w: 0, dots: 0, wd: 0, nb: 0 };
          for (let i = 1; i < cells.length; i++) {
            const key = MS_BOWL_HEADER_MAP[(bowlingCols?.[i] || '').toUpperCase()];
            if (key && cells[i] !== '') row[key] = key === 'o' ? cells[i] : (parseFloat(cells[i]) || 0);
          }
          cur.bowling.push(row);
        }
      }

      if (!innings.length) {
        throw new Error('Could not find any team/innings in that paste. Expected a team name on its own line, then "Batting", then rows, then "Bowling", then rows — same layout as a normal scorecard.');
      }

      // Fill in r/w/o for any innings whose "Total" line wasn't present or
      // didn't parse, from the batting/bowling rows themselves. Cosmetic
      // only — scoring never depends on these team totals.
      const oversToBalls = (o) => { const [a, b] = String(o ?? 0).split('.'); return (parseInt(a, 10) || 0) * 6 + (parseInt(b || '0', 10) || 0); };
      const ballsToOvers = (n) => `${Math.floor(n / 6)}.${n % 6}`;
      innings.forEach(inn => {
        if (inn.r == null) inn.r = inn.batting.reduce((s, b) => s + (b.r || 0), 0) + (inn._extras || 0);
        if (inn.w == null) inn.w = inn.batting.filter(b => !/not\s*out/i.test(b['dismissal-text'])).length;
        if (inn.o == null) inn.o = ballsToOvers(inn.bowling.reduce((s, b) => s + oversToBalls(b.o), 0));
        delete inn._extras;
      });

      return {
        data: {
          matchInfo: { name: matchLabel || innings.map(i => i.inning).join(' vs ') },
          status: 'Match ended',
          scorecard: innings,
        },
      };
    }

    /**
     * Saves a manually-parsed scorecard for one match through the exact same
     * scoring path a live CricAPI connection uses (fromCricAPI → merge →
     * calculateScore), then optionally marks the match completed and always
     * cascades to XI/SL totals — mirroring saveFantasyScorecard()/
     * rescoreCurrentMatch(), but addressed by matchId instead of the Live
     * tab's currently-selected #matchId.
     */
    async function saveManualScorecardForMatch(matchId, payload, { markCompleted = true } = {}) {
      if (!state.db) throw new Error('Connect a database first.');
      const local = state.matches.find(m => m.id === matchId);
      if (!local) throw new Error('Match not found locally — sync first.');

      const apiPlayers = fromCricAPI(payload, matchSquadFor(local), local.format || state.format);
      const { matched, unmatched } = mergeApiPlayersByLocalId(apiPlayers, findLocalByName);
      const rows = matched.map(({ local: lp, pl }) => {
        const s = calculateScore({ ...pl, role: lp.role, captaincy: 'normal' }, local.format || state.format);
        // source:'scraper_manual' is the SAME tag applyManualFieldingCredit()
        // already uses -- scrape-scorecard's per-player guard skips a row
        // unconditionally once it carries this tag, so a mid-match manual
        // paste survives the next automatic scrape (which runs every ~15
        // min for a still-live match) instead of being silently overwritten
        // the moment the scraper's next read has equal-or-more balls than
        // what you entered. Trade-off: it also means the scraper will never
        // auto-correct these rows again on its own -- re-paste manually once
        // the match actually finishes if you saved this mid-match. Follow-up
        // to make this catch-up-aware instead of permanent: see
        // docs/score_audit_track_streamline_plan.md §3.7.
        return { playerId: lp.id, batting: pl.batting ?? null, bowling: pl.bowling ?? null, fielding: pl.fielding ?? null, rawPoints: s.rawPoints, source: 'scraper_manual' };
      });
      if (!rows.length) {
        throw new Error(`No pasted names matched your roster for ${local.home_team_id} vs ${local.away_team_id} (${unmatched.length} unmatched). Check spelling / that this is the right match.`);
      }

      const n = await state.db.bulkUpsertPlayerMatchStats(matchId, rows);

      // A manual scorecard is the admin directly confirming the final result
      // by hand -- a stronger signal than any automated scrape/poll, so a
      // successful save also clears the "⚠ unverified" badge (stats_verified_at),
      // not just Finalize checkbox status. Covers two cases: (a) this save is
      // what completes the match, and (b) the match was already marked
      // completed (e.g. by scrape-scorecard's staleness-guard bypass on a
      // rain/DLS-curtailed finish it couldn't confirm on its own) and this
      // save is the trustworthy confirmation that was missing.
      if (markCompleted || local.status === 'completed') {
        const upd = await state.db.updateMatch(matchId, {
          status: 'completed',
          statsVerifiedAt: new Date().toISOString(),
        });
        const idx = state.matches.findIndex(x => x.id === matchId);
        if (idx >= 0) state.matches[idx] = upd;
      }

      const xiSaved = await computeAndSaveXIScoresForMatch(matchId);
      await computeAndSaveSLScoresForMatch(matchId);

      // Persist anything fromCricAPI() couldn't resolve into the same queue
      // the CricAPI/scraper Finalize path already writes to (see Finalize's
      // own insertFieldingIssues call above), tagged source='manual' so it's
      // distinguishable from scraped/API-sourced issues — otherwise a manually
      // entered scorecard's unresolved fielding credit never reaches Review →
      // Fielding Issues at all, and "check Review" is a dead end for admins.
      // Best-effort: a failure here shouldn't fail the save itself — the
      // credit for everyone who DID resolve is already saved.
      if (apiPlayers.fieldingIssues?.length) {
        try {
          await state.db.insertFieldingIssues(local.tournament_id, matchId, apiPlayers.fieldingIssues, 'manual');
        } catch (fiErr) {
          console.warn('[Manual scorecard] insertFieldingIssues failed (fielding issues still reported below, just not queued in Review):', fiErr.message);
        }
      }
      // Same treatment as fielding issues above: flag any bowler on 3+
      // wickets this innings for Review → 🎩 Potential Hat-tricks.
      const hattrickCandidates = rows
        .filter(r => (r.bowling?.wickets ?? 0) >= 3)
        .map(r => ({ playerId: r.playerId, wickets: r.bowling.wickets }));
      if (hattrickCandidates.length) {
        try {
          await state.db.insertPotentialHattricks(local.tournament_id, matchId, hattrickCandidates, 'manual');
        } catch (htErr) {
          console.warn('[Manual scorecard] insertPotentialHattricks failed (not queued in Review):', htErr.message);
        }
      }

      // Same treatment for unmatched batter/bowler *identities* (not just
      // fielding credit): without this, a manually pasted scorecard's
      // unmatched names only ever showed up live in the Fantasy Scorecard's
      // red "Link" rows (recomputed client-side on every render) and never
      // reached Review → ⚠️ Unmatched Players, which reads the persisted
      // scraper_unmatched table — the cron paths (poll-cricapi/
      // scrape-scorecard) write there directly, but this manual path never
      // did. Best-effort, same reasoning as insertFieldingIssues above: a
      // failure here shouldn't fail the save itself.
      if (unmatched.length) {
        try {
          await state.db.insertUnmatchedPlayers(local.tournament_id, matchId, unmatched, 'manual');
        } catch (upErr) {
          console.warn('[Manual scorecard] insertUnmatchedPlayers failed (unmatched players still reported below, just not queued in Review):', upErr.message);
        }
      }

      // Persist the raw payload (dismissal text included) to match_scorecards
      // — the same cache table scrape-scorecard writes to and connectLiveViaScraper
      // prefers over its own stats-only reconstruction. Without this, a
      // scraper-tracked match's poller (running every ~60s once the Live tab
      // is open) rebuilds state.lastScorecard from player_match_stats via
      // buildLiveScorecardFromStats(), which only carries isDismissed (a
      // boolean) — never the "c Fielder b Bowler" text — so any dismissal
      // detail you pasted would render fine for a few seconds and then get
      // silently wiped by the next poll. Writing it here means the poller's
      // own preferred source already has it. Best-effort: a cache-write
      // failure shouldn't fail the save — the scores that matter (raw_points)
      // are already committed above.
      try {
        await state.db.saveMatchScorecard(matchId, payload);
      } catch (scErr) {
        console.warn('[Manual scorecard] saveMatchScorecard failed (points are saved; raw scorecard cache was not updated):', scErr.message);
      }

      // Wire it into the Live tab exactly like a real connected match: same
      // state.lastScorecard the live poller would have produced, so the raw
      // Live scorecard panel, the Fantasy Scorecard panel (with its
      // unmatched-name Link buttons and fielding-issue banner), Rescore and
      // Save-to-DB all just work on it afterwards.
      state.lastScorecard = payload;
      const sel = $('#matchId');
      if (sel) {
        if (local.external_id) {
          if (typeof renderMatchIdDropdown === 'function') renderMatchIdDropdown();
          sel.value = local.external_id;
        } else {
          const tempVal = `manual:${local.id}`;
          if (![...sel.options].some(o => o.value === tempVal)) {
            const opt = document.createElement('option');
            opt.value = tempVal;
            opt.textContent = `M${local.match_number ?? '?'} ${local.home_team_id} vs ${local.away_team_id} (manual)`;
            sel.appendChild(opt);
          }
          sel.value = tempVal;
        }
        sel.dispatchEvent(new Event('change'));
      }

      renderFantasyScorecard();
      if (typeof renderScorecard === 'function') renderScorecard();
      renderMatchesAdmin();

      return { saved: n, unmatched: unmatched.map(p => p.name), xiSaved, fieldingIssues: apiPlayers.fieldingIssues || [] };
    }

    async function toggleManualScorecardRow(matchId, tr) {
      const existing = tr.parentElement?.querySelector(`.manual-sc-row[data-matchid="${matchId}"]`);
      if (existing) { existing.remove(); return; }
      $('#adminMatchesBody')?.querySelectorAll('.manual-sc-row, .fielding-credit-row').forEach(r => r.remove());

      const m = state.matches.find(x => x.id === matchId);
      if (!m) return;

      const formRow = document.createElement('tr');
      formRow.className = 'manual-sc-row';
      formRow.dataset.matchid = matchId;
      formRow.innerHTML = `
        <td colspan="10" style="padding:10px; background:rgba(80,160,255,0.06); border-top:1px dashed rgba(80,160,255,0.4);">
          <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">
            <strong style="color:var(--text);">📋 Manual scorecard</strong> for
            M${escapeHtml(String(m.match_number ?? '?'))} (${escapeHtml(m.home_team_id||'—')} vs ${escapeHtml(m.away_team_id||'—')})
            — upload the scorecard as an Excel file, or paste it as text: a team name on its own line, "Batting",
            the batting rows (name · dismissal · R · B · 4s · 6s), "Bowling", the bowling rows
            (name · O · M · R · W · Econ · 0s · Wd · Nb), then the same for the other team. Uploading fills in the
            text box below so you can check it before saving.
          </div>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <label style="font-size:11px; color:var(--muted); display:flex; align-items:center; gap:6px;">
              <span>Upload Excel:</span>
              <input type="file" class="msc-file" accept=".xlsx,.xls,.csv" style="font-size:11px;" />
            </label>
          </div>
          <textarea class="msc-paste" rows="8" spellcheck="false"
            style="width:100%; font-family:monospace; font-size:11px; padding:6px; box-sizing:border-box;"
            placeholder="Paste the full scorecard here (both innings)…"></textarea>
          <label style="font-size:11px; color:var(--muted); display:flex; align-items:center; gap:6px; margin-top:6px;">
            <input type="checkbox" class="msc-complete" ${m.status !== 'completed' ? 'checked' : ''} />
            <span>mark match completed</span>
          </label>
          <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
            <button class="msc-save" style="font-size:11px; padding:4px 10px; border-radius:4px; background:rgba(80,160,255,0.15); border:1px solid rgba(80,160,255,0.5); color:var(--text); cursor:pointer; flex-shrink:0;">Save &amp; score</button>
            <button class="msc-cancel" style="font-size:11px; padding:4px 10px; border-radius:4px; background:transparent; border:1px solid var(--border); color:var(--muted); cursor:pointer; flex-shrink:0;">Cancel</button>
            <span class="msc-status" style="font-size:11px; color:var(--muted); flex:1 1 160px; min-width:120px;"></span>
          </div>
        </td>`;
      tr.after(formRow);

      formRow.querySelector('.msc-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const statusEl = formRow.querySelector('.msc-status');
        const textarea = formRow.querySelector('.msc-paste');
        statusEl.textContent = `Reading ${file.name}…`;
        try {
          await loadXlsxLib();
          const buf = await file.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array' });
          textarea.value = xlsxWorkbookToPasteText(wb);
          statusEl.textContent = `Loaded from ${file.name} — review below, then Save & score.`;
        } catch (err) {
          statusEl.textContent = 'Failed to read file: ' + err.message;
        }
      });
      formRow.querySelector('.msc-cancel').addEventListener('click', () => formRow.remove());
      formRow.querySelector('.msc-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const statusEl = formRow.querySelector('.msc-status');
        const text = formRow.querySelector('.msc-paste').value;
        const markCompleted = formRow.querySelector('.msc-complete').checked;
        btn.disabled = true; statusEl.textContent = 'Parsing…';
        try {
          const payload = parseManualScorecardPaste(text, `${m.home_team_id} vs ${m.away_team_id}`);
          statusEl.textContent = 'Scoring & saving…';
          const result = await saveManualScorecardForMatch(matchId, payload, { markCompleted });
          const bits = [`✓ Saved ${result.saved} player row${result.saved===1?'':'s'}`];
          if (result.xiSaved) bits.push(`${result.xiSaved} XI total${result.xiSaved===1?'':'s'} updated`);
          if (result.unmatched.length) bits.push(`⚠ ${result.unmatched.length} unmatched: ${result.unmatched.join(', ')} — open Live → Fantasy Scorecard to Link them`);
          if (result.fieldingIssues.length) bits.push(`⚠ ${result.fieldingIssues.length} fielding event${result.fieldingIssues.length===1?'':'s'} queued in Review → Fielding Issues`);
          toast(bits.join(' · '), 8000);
          formRow.remove();
        } catch (err) {
          statusEl.textContent = 'Failed: ' + err.message;
          btn.disabled = false;
        }
      });
    }

    // datetime-local input → ISO UTC string (Postgres timestamptz-friendly)
    function localInputToIso(v) {
      if (!v) return null;
      // new Date('2026-05-12T19:30') treats it as local — toISOString → UTC
      const d = new Date(v);
      return isNaN(d) ? null : d.toISOString();
    }

    async function addMatchHandler() {
      const row = $('#addMatchRow');
      const matchNumber = parseInt(row.querySelector('[data-f="match_number"]').value, 10);
      const home    = row.querySelector('[data-f="home_team_id"]').value;
      const away    = row.querySelector('[data-f="away_team_id"]').value;
      const format  = row.querySelector('[data-f="format"]').value;
      const startTime = localInputToIso(row.querySelector('[data-f="start_time"]').value);
      const playedOn = startTime ? startTime.slice(0, 10) : null;
      const status    = row.querySelector('[data-f="status"]').value;
      const matchType = row.querySelector('[data-f="match_type"]')?.value || null;
      const dataSource = row.querySelector('[data-f="data_source"]')?.value || 'auto';
      const lockTime  = localInputToIso(row.querySelector('[data-f="lock_time"]').value) || null;
      if (home === away) { toast('Home and away teams must differ.'); return; }
      try {
        if (state.db) {
          const m = await state.db.addMatch({
            tournamentId: state.activeTournamentId,
            matchNumber, format, homeTeamId: home, awayTeamId: away,
            playedOn, startTime, lockTime, status, matchType, dataSource,
          });
          state.matches.push(m);
        } else {
          state.matches.push({
            id: 'local-' + Date.now(),
            tournament_id: state.activeTournamentId,
            match_number: matchNumber, format, home_team_id: home, away_team_id: away,
            played_on: playedOn, start_time: startTime, lock_time: lockTime, status,
          });
        }
        toast(`Added Match ${matchNumber}.`);
        renderMatchesAdmin(); renderMatchSelector();
      } catch (e) { toast('Add failed: ' + e.message, 4000); }
    }

    async function saveMatchEdit(id, tr) {
      const startTime = localInputToIso(tr.querySelector('[data-f="start_time"]').value);
      const lockTime  = localInputToIso(tr.querySelector('[data-f="lock_time"]').value) || null;
      // Existing rows show a read-only badge; status is managed via the delay toggle button.
      // Fall back to the current status stored in state to avoid overwriting it.
      const statusEl      = tr.querySelector('[data-f="status"]');
      const matchTypeEl   = tr.querySelector('[data-f="match_type"]');
      const dataSourceEl  = tr.querySelector('[data-f="data_source"]');
      const existing       = state.matches.find(m => m.id === id);
      const currentStatus  = existing?.status ?? 'scheduled';
      // A newly-typed lock_time only takes effect once status is 'delayed' —
      // the lock-matches cron job ignores lock_time entirely for 'scheduled'
      // matches (see effectiveLockTime()/push-time-btn comments). Auto-promote
      // here too, not just via the quick-push buttons, so typing straight into
      // the lock_time field can't silently no-op the same way.
      const lockTimeChanged = lockTime && lockTime !== existing?.lock_time;
      const autoStatus      = (lockTimeChanged && currentStatus === 'scheduled') ? 'delayed' : currentStatus;
      const patch = {
        matchNumber: parseInt(tr.querySelector('[data-f="match_number"]').value, 10),
        homeTeamId : tr.querySelector('[data-f="home_team_id"]').value || null,
        awayTeamId : tr.querySelector('[data-f="away_team_id"]').value || null,
        format     : tr.querySelector('[data-f="format"]').value,
        matchType  : matchTypeEl ? (matchTypeEl.value || null) : undefined,
        dataSource : dataSourceEl ? (dataSourceEl.value || 'auto') : undefined,
        startTime  : startTime,
        playedOn   : startTime ? startTime.slice(0, 10) : null,
        lockTime   : lockTime,
        status     : statusEl ? statusEl.value : autoStatus,
      };
      if (patch.homeTeamId && patch.awayTeamId && patch.homeTeamId === patch.awayTeamId) {
        toast('Home and away teams must differ.'); return;
      }
      try {
        if (state.db) {
          const upd = await state.db.updateMatch(id, patch);
          const idx = state.matches.findIndex(m => m.id === id);
          if (idx >= 0) state.matches[idx] = upd;
        } else {
          const idx = state.matches.findIndex(m => m.id === id);
          if (idx >= 0) state.matches[idx] = {
            ...state.matches[idx],
            match_number: patch.matchNumber, home_team_id: patch.homeTeamId, away_team_id: patch.awayTeamId,
            format: patch.format, played_on: patch.playedOn, start_time: patch.startTime, lock_time: patch.lockTime, status: patch.status,
          };
        }
        tr.querySelectorAll('.dirty').forEach(el => el.classList.remove('dirty'));
        renderMatchSelector();
      } catch (e) { toast('Save failed: ' + e.message, 4000); }
    }


    // ─── CRICAPI MATCH SYNC ──────────────────────────────────────────────────
    // Maps CricAPI's response shape to our matches table.

    const CRIC_FORMAT_MAP = { t20:'T20', odi:'ODI', test:'TEST', 't20i':'T20' };

    // CricAPI uses its own internal shortcodes that don't always match what we
    // store in the teams table. Translate them to our codes here. Add more as
    // CricAPI surfaces them.
    const CRIC_TEAM_CODE_MAP = {
      'RCBW': 'RCB',   // Royal Challengers Bengaluru (men's franchise)
    };
    // Load any aliases previously saved via "Fix Match Teams" or the alias editor.
    // This ensures future CricAPI syncs translate codes correctly at ingest time.
    const CRIC_ALIAS_LS = 'cricTeamAliases';
    try {
      const saved = JSON.parse(localStorage.getItem(CRIC_ALIAS_LS) || '{}');
      Object.assign(CRIC_TEAM_CODE_MAP, saved);
    } catch (e) {}

    function aliasCricTeamCode(code) {
      return code ? (CRIC_TEAM_CODE_MAP[code] ?? code) : code;
    }

    /** Persist one or more aliases and apply them to the live map immediately. */
    function saveAliases(newEntries) {
      Object.assign(CRIC_TEAM_CODE_MAP, newEntries);
      try {
        const existing = JSON.parse(localStorage.getItem(CRIC_ALIAS_LS) || '{}');
        localStorage.setItem(CRIC_ALIAS_LS, JSON.stringify({ ...existing, ...newEntries }));
      } catch (e) {}
    }

    /** Remove an alias from the live map and from localStorage. */
    function removeAlias(key) {
      delete CRIC_TEAM_CODE_MAP[key];
      try {
        const existing = JSON.parse(localStorage.getItem(CRIC_ALIAS_LS) || '{}');
        delete existing[key];
        localStorage.setItem(CRIC_ALIAS_LS, JSON.stringify(existing));
      } catch (e) {}
    }

    function cricStatusToOurs(item) {
      // /currentMatches uses `ms`: 'result' / 'live' / 'fixture'
      if (item.ms === 'result')  return 'completed';
      if (item.ms === 'live')    return 'in_progress';
      if (item.ms === 'fixture') return 'scheduled';
      // /series_info doesn't have `ms` — fall back to status string
      const s = String(item.status || '').toLowerCase();
      if (/won by|tied|no result|abandoned|drawn|match completed/i.test(s)) return 'completed';
      if (/in progress|live|innings break|stumps|tea|lunch|drinks/i.test(s)) return 'in_progress';
      return 'scheduled';
    }

    function cricTeamCode(teamName) {
      // /currentMatches returns names like "Gujarat Titans [GT]" — extract the bracketed code.
      const m = String(teamName || '').match(/\[([A-Z0-9]+)\]/);
      return m ? m[1] : null;
    }

    function parseMatchNumberFromName(name) {
      // "MI vs CSK, 14th Match, Indian Premier League, 2026" → 14
      const m = String(name || '').match(/\b(\d+)\s*(?:st|nd|rd|th)?\s*Match\b/i);
      return m ? parseInt(m[1], 10) : null;
    }

    const MONTH_ABBR = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

    // CricAPI's series_info feed sometimes truncates dateTimeGMT to midnight
    // (e.g. "2026-06-18T00:00:00") and drops the real kickoff time entirely —
    // seen on the MLC 2026 series. The actual time survives in the human-readable
    // `status` string instead, e.g. "Match starts at Jun 19, 00:30 GMT". When we
    // spot the midnight-truncation pattern, parse the real time out of `status`
    // and use that instead. Falls through untouched for every other tournament
    // where dateTimeGMT is already correct (the regex just won't match).
    function fixMidnightGmtFromStatus(rawDt, item) {
      if (!rawDt || !/T00:00:00(\.000)?Z?$/.test(rawDt)) return rawDt;
      const m = String(item.status || '').match(/Match starts at\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*GMT/i);
      if (!m) return rawDt;
      const monthIdx = MONTH_ABBR[m[1].toLowerCase()];
      if (monthIdx == null) return rawDt;
      const day = parseInt(m[2], 10), hour = parseInt(m[3], 10), min = parseInt(m[4], 10);
      const base = new Date(rawDt.slice(0, 10) + 'T00:00:00Z');
      if (isNaN(base)) return rawDt;
      let year = base.getUTCFullYear();
      if (monthIdx === 0 && base.getUTCMonth() === 11) year += 1; // Dec → Jan year rollover
      const corrected = new Date(Date.UTC(year, monthIdx, day, hour, min, 0));
      return isNaN(corrected) ? rawDt : corrected.toISOString();
    }

    function cricItemToMatch(item, tournamentId) {
      // Team code source: /series_info gives `teamInfo` with shortname; /currentMatches gives bracketed names.
      let home = null, away = null;
      if (Array.isArray(item.teamInfo) && item.teamInfo.length >= 2) {
        home = aliasCricTeamCode(item.teamInfo[0]?.shortname || null);
        away = aliasCricTeamCode(item.teamInfo[1]?.shortname || null);
      }
      if (!home) home = aliasCricTeamCode(cricTeamCode(item.t1));
      if (!away) away = aliasCricTeamCode(cricTeamCode(item.t2));

      const fmt = CRIC_FORMAT_MAP[String(item.matchType || '').toLowerCase()] || 'T20';
      // CricAPI dateTimeGMT is already an ISO UTC string — Postgres timestamptz parses it directly.
      const rawDt = fixMidnightGmtFromStatus(item.dateTimeGMT || item.date || '', item);
      return {
        tournamentId,
        externalId : item.id,
        matchNumber: parseMatchNumberFromName(item.name),
        format     : fmt,
        homeTeamId : home,
        awayTeamId : away,
        playedOn   : rawDt.slice(0, 10) || null,
        startTime  : rawDt || null,
        status     : cricStatusToOurs(item),
        notes      : item.name || null,
      };
    }

    const SERIES_ID_LS = 'ss_cricapi_series_id';
    const API_DAILY_LIMIT = 20;   // 2 accounts × 10 calls each
    const API_COUNT_LS    = 'ss_cricapi_count';   // { date, count }

    function getApiCallCount() {
      try {
        const stored = JSON.parse(localStorage.getItem(API_COUNT_LS) || '{}');
        const today  = new Date().toISOString().slice(0, 10);
        if (stored.date !== today) return 0;   // new day — reset
        return stored.count || 0;
      } catch { return 0; }
    }

    function incrementApiCallCount() {
      const today = new Date().toISOString().slice(0, 10);
      const count = getApiCallCount() + 1;
      localStorage.setItem(API_COUNT_LS, JSON.stringify({ date: today, count }));
      renderApiPill(count);
      return count;
    }

    function renderApiPill(count = getApiCallCount()) {
      const pill = $('#apiPill');
      if (!pill) return;
      pill.textContent = `API ${count} / ${API_DAILY_LIMIT}`;
      pill.className = 'api-pill';
      if (count >= API_DAILY_LIMIT)       pill.classList.add('danger');
      else if (count >= API_DAILY_LIMIT * 0.8) pill.classList.add('warn');
      pill.title = `CricAPI calls today: ${count} of ${API_DAILY_LIMIT} daily limit`;
    }

    async function fetchJsonFromProxy(path) {
      incrementApiCallCount();
      const res = await fetch('https://api.cricapi.com/v1/' + path);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.status === 'failure') throw new Error(json.reason || 'CricAPI failure');
      return json;
    }

    // ─── API key fallback helpers ─────────────────────────────────────────────

    /** Returns all known API keys with the currently active one first. */
    function getApiKeys() {
      const current = $('#apiKey').value.trim();
      const stored = [...$('#apiKeyPicker').options]
        .map(o => o.value)
        .filter(v => v && v !== 'custom');
      const others = stored.filter(k => k !== current);
      return current ? [current, ...others] : stored;
    }

    /** Switches the active API key in the input + localStorage + picker. */
    function setActiveApiKey(key) {
      $('#apiKey').value = key;
      localStorage.setItem(API_KEY_LS, key);
      const opt = [...$('#apiKeyPicker').options].find(o => o.value === key);
      $('#apiKeyPicker').value = opt ? key : 'custom';
      toast(`API key exhausted — switched to …${key.slice(-4)}.`, 4000);
    }

    /** Returns true for errors that mean the key is spent / invalid (not network / match-not-found). */
    function isKeyExhaustedError(msg) {
      return /blocked|daily.limit|quota|too.many|429|invalid.*key|unauthori[sz]/i.test(String(msg));
    }

    /**
     * Like fetchJsonFromProxy but automatically retries with the next stored
     * key when the active one is exhausted or returns an auth error.
     *
     * @param {function} pathFn  Called with each candidate key — returns the
     *                           proxy path string, e.g.:
     *                           key => `match_scorecard?apikey=${key}&id=…`
     */
    async function fetchJsonWithFallback(pathFn) {
      const keys = getApiKeys();
      let lastErr;
      for (const key of keys) {
        try {
          const result = await fetchJsonFromProxy(pathFn(key));
          // Succeeded — if we used a different key, make it the active one
          if (key !== $('#apiKey').value.trim()) setActiveApiKey(key);
          return result;
        } catch (err) {
          lastErr = err;
          if (!isKeyExhaustedError(err.message)) throw err; // not a quota/auth issue — bail immediately
        }
      }
      throw lastErr; // all keys exhausted
    }

    async function fetchSeriesInfo(apiKey, seriesId) {
      const json = await fetchJsonWithFallback(k => `series_info?apikey=${encodeURIComponent(k)}&id=${encodeURIComponent(seriesId)}`);
      return Array.isArray(json.data?.matchList) ? json.data.matchList : [];
    }

    async function fetchCurrentMatchesPaginated(apiKey) {
      let all = [], offset = 0;
      for (let page = 0; page < 5; page++) {
        const json = await fetchJsonWithFallback(k => `currentMatches?apikey=${encodeURIComponent(k)}&offset=${offset}`);
        const batch = Array.isArray(json.data) ? json.data : [];
        if (!batch.length) break;
        all = all.concat(batch);
        offset += batch.length;
        if (batch.length < 25) break;
      }
      return all;
    }

    // Categorise an error message so the user can scan reasons at a glance.
    function classifyFinalizeError(msg) {
      const s = String(msg || '').toLowerCase();
      if (/blocked|daily limit|quota|too many/i.test(s)) return 'quota';
      if (/scorecard .*not found|404|no .*scorecard/i.test(s)) return 'no scorecard';
      if (/invalid .*key|unauthor/i.test(s)) return 'auth';
      if (/cors|failed to fetch|network|enotfound|getaddrinfo/i.test(s)) return 'network';
      if (/no.* players|0 players|empty/i.test(s)) return 'empty';
      return 'other';
    }

    /**
     * Finalize a single match — fetch (or load from cache) its scorecard,
     * compute fantasy points, and persist to player_match_stats.
     * Returns { match, players, unmatched } on success, throws on failure.
     */
    async function finalizeOneMatch(m, apiKey) {
      const matchLabel = `M${m.match_number ?? '?'} ${m.home_team_id || '—'} vs ${m.away_team_id || '—'}`;

      // Reuse a cached scorecard ONLY if it already looks finished — a cache
      // taken mid-match (e.g. the live poller's last snapshot before a chase
      // wrapped up) would otherwise get reused forever, since this would keep
      // "succeeding" without ever fetching the actual final data. If the
      // cached payload doesn't look done yet, always fetch fresh from CricAPI.
      // (Absorbed from the former forceRefinalizeMatch/"Recalc" — Finalize and
      // Recalc were merged into this one function; see
      // docs/score_audit_track_streamline_plan.md §3.2.)
      let json;
      let cached = null;
      try { cached = await state.db.getMatchScorecard(m.id); } catch (_) {}
      const cachedLooksFinished = cached && matchLifecycle(cached, m.format) === 'completed';

      if (cachedLooksFinished) {
        json = cached;
      } else {
        json = await fetchJsonWithFallback(k => `match_scorecard?apikey=${encodeURIComponent(k)}&id=${encodeURIComponent(m.external_id)}`);
        await state.db.saveMatchScorecard(m.id, json);
      }

      const players = fromCricAPI(json, matchSquadFor(m), m.format);
      if (!players.length) throw new Error('CricAPI returned no player rows');

      // Fielding summary to console for easy verification (also absorbed from
      // the former Recalc, which had this and Finalize didn't).
      const fieldingPlayers = players.filter(p => p.fielding &&
        (p.fielding.catches + p.fielding.stumpings + p.fielding.runOutDirect + p.fielding.runOutIndirect) > 0);
      console.group(`[Finalize] M${m.match_number ?? '?'} — ${players.length} players, ${fieldingPlayers.length} with fielding`);
      console.table(fieldingPlayers.map(p => ({
        name: p.name,
        catches: p.fielding.catches,
        stumpings: p.fielding.stumpings,
        runOutDirect: p.fielding.runOutDirect,
        runOutIndirect: p.fielding.runOutIndirect,
        fieldingPts: calcFielding(p.fielding, m.format || 'T20').total,
      })));
      console.groupEnd();
      // Merge (not skip) duplicate API names that resolve to the same local
      // player — see mergeApiPlayersByLocalId. Skipping used to silently
      // drop whichever entry lost the race (e.g. a fielding-only mention).
      const { matched, unmatched: unmatchedPl } = mergeApiPlayersByLocalId(players, findLocalByName);
      const unmatchedNames = unmatchedPl.map(p => p.name);

      // Manual-correction guard: a player row an admin corrected by hand
      // (Review tab "Credit", or the row's 🥎 Fielding button — both tag the
      // row source='scraper_manual') always wins. Without this, the blind
      // upsert below would silently overwrite that correction with whatever
      // CricAPI's own parse produces — with no error, no warning, the fix
      // just gone. Mirrors the identical guard scrape-scorecard/index.ts
      // already has server-side (search "per-player regression guard" there).
      // See docs/score_audit_track_streamline_plan.md §3.6.
      let manuallyCorrectedIds = new Set();
      try {
        const existingStats = await state.db.getPlayerStatsForMatch(m.id);
        manuallyCorrectedIds = new Set(
          existingStats.filter(s => s.source === 'scraper_manual').map(s => s.player_id)
        );
      } catch (_) { /* best-effort — a failed lookup here just means no rows get protected this run */ }

      const protectedMatches = matched.filter(({ local }) => manuallyCorrectedIds.has(local.id));
      const rows = matched
        .filter(({ local }) => !manuallyCorrectedIds.has(local.id))
        .map(({ local, pl }) => {
          // Use the local DB role, not the API-derived role.  fromCricAPI promotes any player
          // who both bats AND bowls to 'ar', which incorrectly triggers the duck penalty for
          // specialist bowlers who bat lower-order.  The DB role is the authoritative designation.
          const s = calculateScore({ ...pl, role: local.role, captaincy: 'normal' }, m.format);
          return {
            playerId: local.id,
            batting : pl.batting  ?? null,
            bowling : pl.bowling  ?? null,
            fielding: pl.fielding ?? null,
            rawPoints: s.rawPoints,
          };
        });
      if (!rows.length && !protectedMatches.length) throw new Error(`No player name from API matched local pool (${players.length} API players, all unmatched)`);
      if (rows.length) await state.db.bulkUpsertPlayerMatchStats(m.id, rows);
      await computeAndSaveXIScoresForMatch(m.id);
      await computeAndSaveSLScoresForMatch(m.id);
      // Only mark the match row 'completed' if the scorecard we just fetched
      // actually says the match has ended. Previously this unconditionally set
      // status='completed' just because Finalize was clicked — if Finalize ran
      // while the match was still live (e.g. clicked too early, or an automated
      // sync fired mid-chase), the match got permanently mislabeled 'completed'
      // even though the scorecard status (e.g. "X need N runs in M balls") showed
      // it was still in progress. Once mislabeled, every status!=='completed'
      // filter elsewhere in the app (live polling, "needs finalization" lists,
      // etc.) would skip it forever, freezing it on a partial snapshot.
      const lifecycle = matchLifecycle(json, m.format);
      const looksFinished = lifecycle === 'completed';
      if (looksFinished && m.status !== 'completed') {
        const upd = await state.db.updateMatch(m.id, { status: 'completed' });
        const idx = state.matches.findIndex(x => x.id === m.id);
        if (idx >= 0) state.matches[idx] = upd;
      }
      // Persist anything fromCricAPI() couldn't resolve into the same queue
      // poll-cricapi already writes to server-side, so it shows up in Review →
      // Fielding Issues instead of only ever reaching a console.warn.
      // Best-effort: a failure here shouldn't fail the finalize itself — the
      // credit for everyone it DID resolve is already saved.
      // See docs/fielding_credit_single_source_plan.md.
      if (players.fieldingIssues?.length) {
        try {
          await state.db.insertFieldingIssues(m.tournament_id, m.id, players.fieldingIssues, 'cricapi');
        } catch (fiErr) {
          console.warn('[Finalize] insertFieldingIssues failed (fielding issues still reported below, just not queued in Review):', fiErr.message);
        }
      }
      // Flag any bowler on 3+ wickets this innings for Review → 🎩 Potential
      // Hat-tricks — none of our sources report ball-by-ball sequencing, so
      // this is only ever a candidate for an admin to confirm/decline after
      // checking the real scorecard. Best-effort, same reasoning as the
      // fielding-issues insert just above.
      const hattrickCandidates = rows
        .filter(r => (r.bowling?.wickets ?? 0) >= 3)
        .map(r => ({ playerId: r.playerId, wickets: r.bowling.wickets }));
      if (hattrickCandidates.length) {
        try {
          await state.db.insertPotentialHattricks(m.tournament_id, m.id, hattrickCandidates, 'cricapi');
        } catch (htErr) {
          console.warn('[Finalize] insertPotentialHattricks failed (not queued in Review):', htErr.message);
        }
      }

      return {
        match: matchLabel,
        players: rows.length,
        unmatched: unmatchedNames.length,
        unmatchedNames,
        fieldingIssues: players.fieldingIssues || [],
        scorecard: json,
        matchLooksFinished: looksFinished,
        liveStatusText: json?.data?.status ?? json?.status ?? '',
        manuallyProtected: protectedMatches.length,
      };
    }

    /**
     * Per-row finalize: called when the user clicks the Finalize button on a
     * specific match row in the Matches admin table.
     */
    async function finalizeMatchById(matchId) {
      const apiKey = $('#apiKey').value.trim();
      if (!apiKey) { toast('Enter your CricAPI key in Settings first.', 4000); return; }
      if (!state.db)  { toast('Connect to the database first.', 4000); return; }

      const statusEl = $('#syncStatus');
      const btn = document.querySelector(`#adminMatchesBody tr[data-id="${matchId}"] .row-finalize`);
      if (btn) { btn.disabled = true; btn.textContent = '…'; }

      try {
        // Fetch the match with its cachedScorecard flag (scoped to active tournament)
        const pending = await state.db.listMatchesNeedingFinalization(state.activeTournamentId);
        let m = pending.find(x => x.id === matchId);
        if (!m) {
          // Already finalized — just recompute XI scores in case they're stale
          const base = state.matches.find(x => x.id === matchId);
          if (base) { await computeAndSaveXIScoresForMatch(matchId); await computeAndSaveSLScoresForMatch(matchId); }
          toast('Match already finalized.'); return;
        }
        const result = await finalizeOneMatch(m, apiKey);
        renderMatchesAdmin();
        renderHistory();
        // The Fantasy Scorecard panel only ever populated from the live poller's
        // state.lastScorecard — for a match finalized after the fact (no live
        // session ever ran), it stayed empty/"No data yet." even though we now
        // have a freshly fetched scorecard right here. Feed it in so the panel
        // (and its fielding-issue banner) actually shows something.
        state.lastScorecard = result.scorecard;
        renderFantasyScorecard();
        const fIssues = result.fieldingIssues || [];
        const hasUnmatched = result.unmatchedNames?.length > 0;
        const hasFieldingIssues = fIssues.length > 0;
        const notActuallyFinished = result.matchLooksFinished === false;
        const protectedCount = result.manuallyProtected || 0;
        const protectedNote = protectedCount
          ? ` 🛡 ${protectedCount} manually-corrected player row${protectedCount > 1 ? 's' : ''} preserved (not overwritten).`
          : '';
        if (hasUnmatched || hasFieldingIssues || notActuallyFinished) {
          let warn = '';
          if (notActuallyFinished) {
            warn += `⚠ Scorecard doesn't look finished yet (status: "${escapeHtml(result.liveStatusText || 'unknown')}") — match NOT marked completed, stats saved as a snapshot. Re-finalize once it actually ends. `;
          }
          if (hasUnmatched) {
            const list = result.unmatchedNames.map(n => `"${n}"`).join(', ');
            warn += `⚠ ${result.unmatchedNames.length} unmatched: ${escapeHtml(list)}. `;
          }
          if (hasFieldingIssues) {
            warn += `⚠ ${fIssues.length} fielding event${fIssues.length>1?'s':''} not credited: ${escapeHtml(summarizeFieldingIssues(fIssues))}. `;
          }
          statusEl.innerHTML = `✓ ${result.match} — ${result.players} players saved.${escapeHtml(protectedNote)} `
            + `<span style="color:var(--bad);">${warn}`
            + `Open <strong>Fantasy Scorecard ↓</strong>${hasUnmatched ? ', click Link on the red rows,' : ''}`
            + `${hasFieldingIssues ? ' (fielding credit is queued in Review → 🥎 Fielding Issues, not fixable from Fantasy Scorecard)' : ''}`
            + ` then re-finalize.</span>`;
          const toastBits = [];
          if (notActuallyFinished) toastBits.push(`match still in progress — not marked completed`);
          if (hasUnmatched) toastBits.push(`${result.unmatchedNames.length} player(s) unmatched`);
          if (hasFieldingIssues) toastBits.push(`${fIssues.length} fielding event(s) not credited`);
          toast(`Finalized — but ${toastBits.join(' and ')}. Check scorecard.`, 6500);
          // Auto-open the fantasy scorecard so the admin sees the red rows / warning immediately
          $('#fantasyScorecardSection')?.setAttribute('open', '');
          $('#fantasyScorecardSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          statusEl.textContent = `✓ ${result.match} — ${result.players} players saved.${protectedNote}`;
          toast(`Finalized ${result.match}.${protectedCount ? ` (${protectedCount} manual correction${protectedCount > 1 ? 's' : ''} preserved)` : ''}`);
        }
      } catch (e) {
        const kind = classifyFinalizeError(e.message);
        statusEl.textContent = `✗ CricAPI finalize failed [${kind}]: ${e.message}`;

        // ── Scraper fallback ─────────────────────────────────────────────────
        // If the scraper has already written player_match_stats for this match,
        // offer the admin the option to finalise using that data instead.
        try {
          const existingStats = await state.db.getPlayerStatsForMatch(matchId);
          if (existingStats?.length) {
            const scraperRows = existingStats.filter(s => s.source === 'scraper');
            const anyRows     = existingStats.length;
            const label       = scraperRows.length
              ? `${scraperRows.length} player${scraperRows.length !== 1 ? 's' : ''} from scraper (CricketAddictor)`
              : `${anyRows} player${anyRows !== 1 ? 's' : ''} from a previous partial run`;
            const confirmed = window.confirm(
              `CricAPI scorecard not available.\n\n` +
              `Scraper data found: ${label}.\n\n` +
              `Note: scraper data does NOT include fielding points (catches, run-outs, stumpings).\n\n` +
              `Use this data to finalise M${state.matches.find(x => x.id === matchId)?.match_number ?? '?'}?`
            );
            if (confirmed) {
              statusEl.textContent = `Using scraper data (${anyRows} players)…`;
              // Mark completed first so the scoring pipeline treats it correctly
              const matchObj = state.matches.find(x => x.id === matchId);
              if (matchObj && matchObj.status !== 'completed') {
                const upd = await state.db.updateMatch(matchId, { status: 'completed' });
                const idx = state.matches.findIndex(x => x.id === matchId);
                if (idx >= 0) state.matches[idx] = upd;
              }
              const xiSaved = await computeAndSaveXIScoresForMatch(matchId);
              await computeAndSaveSLScoresForMatch(matchId);
              renderMatchesAdmin();
              renderHistory();
              statusEl.textContent = `✓ Finalised from scraper data — ${anyRows} players, ${xiSaved} XI totals updated. Fielding points not included.`;
              toast(`Finalised M${matchObj?.match_number ?? ''} from scraper data.`, 4000);
              if (btn) { btn.disabled = false; btn.textContent = 'Finalize'; }
              return;
            }
          }
        } catch (fallbackErr) {
          console.warn('[finalizeMatchById] scraper fallback check failed:', fallbackErr);
        }

        toast('Finalize failed: ' + e.message, 5000);
        if (btn) { btn.disabled = false; btn.textContent = 'Finalize'; }
      }
    }

    // forceRefinalizeMatch ("Recalc") was merged into finalizeOneMatch —
    // see the cache-check at the top of that function, and
    // docs/score_audit_track_streamline_plan.md §3.2 for why. Kept as a
    // console alias for old muscle-memory / bookmarks pointing at
    // window.__recalcMatch — repointed at finalizeMatchRouted (defined just
    // below) once that existed, so the console shortcut is track-aware too
    // instead of assuming CricAPI.

    /**
     * Scrape one match now — calls the scrape-scorecard edge function for
     * this matchId (the same function the 15-min cron runs for every live
     * scraper-tracked match) and refreshes whatever's currently on screen.
     * This is the scraper-track sibling of finalizeOneMatch/finalizeMatchById
     * — pulled out into its own function (previously inlined directly in the
     * row's 🕷 Scrape click handler) so finalizeMatchRouted() below can call
     * it too when Finalize is clicked on a scraper-tracked match. See
     * docs/score_audit_track_streamline_plan.md §3.2.
     *
     * Unlike finalizeMatchById, this manages no button state itself — the
     * caller (the row's own Scrape handler, or finalizeMatchRouted) is
     * responsible for disabling/relabeling whichever button it was clicked
     * from, since two different buttons can now trigger this.
     */
    async function scrapeMatchNow(matchId) {
      try {
        const supabaseUrl = state.db._supabaseUrl?.() ?? '';
        const anonKey     = state.db._anonKey?.() ?? '';
        const edgeFnUrl   = supabaseUrl.replace('.supabase.co', '.supabase.co/functions/v1') + '/scrape-scorecard';
        const res = await fetch(edgeFnUrl, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
          body   : JSON.stringify({ matchId }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? 'Scrape failed');
        const r = json.results?.[0];
        if (r?.status === 'ok') {
          // Update cached scorecard_url in state
          const m = state.matches.find(x => x.id === matchId);
          if (m && r.url) m.scorecard_url = r.url;
          if (r.completionMarked && m) m.status = 'completed';
          // A 'status: ok' result only ever comes back from the non-stale
          // write path (see scrape-scorecard/index.ts) — the server just
          // stamped stats_verified_at for real, so clear any "⚠ unverified"
          // badge immediately instead of waiting for the next full reload.
          if (m) m.stats_verified_at = new Date().toISOString();
          const bits = [`🕷 Scraped ${r.matched} players from ${r.source}`];
          if (r.unmatched?.length) bits.push(`${r.unmatched.length} unmatched`);
          if (r.fieldingCredited) bits.push(`${r.fieldingCredited} fielding credit${r.fieldingCredited===1?'':'s'} auto-derived`);
          if (r.fieldingIssues)   bits.push(`${r.fieldingIssues} fielding issue${r.fieldingIssues===1?'':'s'} need review (see ⚠️ Fielding Issues below)`);
          if (r.completionMarked) bits.push(`match marked completed`);
          toast(bits.join(' — ') + '.', r.fieldingIssues || r.completionMarked ? 6000 : 4000);
          renderMatchesAdmin();
          // Pull the fresh player_match_stats this scrape just wrote and
          // rebuild the Live/Fantasy scorecard panel right away — otherwise
          // it stays on whatever was last cached (stale until the next poll
          // tick, a Connect/reconnect, or Fetch now), which is exactly the
          // mismatch between "points just scraped" and "what admin sees".
          if (m) {
            try {
              const [statRows, rawScorecard] = await Promise.all([
                state.db.getPlayerStatsForMatchFull(matchId),
                state.db.getMatchScorecard(matchId), // raw scrape this run just cached — every name, matched or not
              ]);
              console.info(`[Scrape Now] player_match_stats rows for match ${matchId}:`, statRows.length, statRows);
              // The squad-only reconstruction needs both teams assigned to this
              // match; the raw scraped scorecard doesn't (it's built straight
              // from the scraped team names, no team_id lookup involved) — so
              // only skip `built` (and its diagnostics) when teams are missing,
              // not the whole render.
              let built = null;
              if (!m.home_team_id || !m.away_team_id) {
                if (!rawScorecard) toast(`Saved ${statRows.length} player rows, but this match has no home_team_id/away_team_id set — can't build the scorecard table without both teams assigned.`, 6000);
              } else {
                built = buildLiveScorecardFromStats(m, statRows);
                if (!built) {
                  const resolvedCount = statRows.filter(s => A.PLAYERS.some(p => p.id === s.player_id)).length;
                  const rosterCount   = A.PLAYERS.filter(p => (p.team_id || p.team) === m.home_team_id || (p.team_id || p.team) === m.away_team_id).length;
                  const matchedTeamIds = [...new Set(
                    statRows.map(s => { const pl = A.PLAYERS.find(p => p.id === s.player_id); return pl && (pl.team_id || pl.team); }).filter(Boolean)
                  )];
                  console.info('[Scrape Now] diagnostic:', {
                    statRowCount: statRows.length, resolvedCount, rosterCount,
                    playersInPool: A.PLAYERS.length, playersSource: A.playersSource,
                    matchedTeamIds, expects: [m.home_team_id, m.away_team_id],
                  });
                  if (!rawScorecard) {
                    if (resolvedCount === 0) {
                      toast(`Saved ${statRows.length} player rows, but NONE of those player_ids exist in the currently loaded ` +
                        `pool (${A.PLAYERS.length} players, source: ${A.playersSource}). Your player pool for ${m.home_team_id}/${m.away_team_id} ` +
                        `has ${rosterCount} players — if that's 0, this tournament's roster was never set up. If it's >0, the scraper resolved ` +
                        `to different player records than your roster (re-check Player Linking).`, 9000);
                    } else {
                      toast(`Saved ${statRows.length} player rows (${resolvedCount} resolved to a player), but their team_id didn't match ` +
                        `${m.home_team_id}/${m.away_team_id}: ${matchedTeamIds.join(', ') || 'none'} — fix the mismatch in Teams/Players.`, 8000);
                    }
                  }
                }
              }
              // Prefer the raw scraped scorecard this run just cached in
              // match_scorecards (every name as scraped, matched or not,
              // with dismissal text) over the squad-only reconstruction —
              // same rich view CricAPI matches get.
              if (rawScorecard || built) {
                state.lastScorecard = rawScorecard || built;
                render();
                renderScorecard();
                renderFantasyScorecard();
                $('#scorecardSection')?.setAttribute('open', '');
              }
            } catch (err2) {
              console.warn('Scrape Now: scorecard refresh failed:', err2.message);
              toast('Scorecard refresh failed: ' + err2.message, 5000);
            }
          }
        } else {
          const detail = r?.error ?? r?.fallback ?? r?.url ?? '';
          console.warn('Scrape Now failed:', r);
          // A 'stale_skipped' result can still have flipped the match to
          // 'completed' (the staleness guard only distrusts the stats/
          // scorecard numbers on this read, not a genuine completion
          // signal — see scrape-scorecard/index.ts step 3b) — reflect that
          // in local state and the row immediately instead of leaving the
          // admin staring at a stale-looking toast with no indication the
          // match actually finished.
          const m = state.matches.find(x => x.id === matchId);
          if (r?.completionMarked && m) {
            m.status = 'completed';
            renderMatchesAdmin();
          }
          toast(`Scrape: ${r?.status ?? 'unknown'} — ${detail}` +
            (r?.completionMarked ? ' — match marked completed despite stale stats; re-scrape once a fresher read lands to fill in stats.' : ''), 7000);
        }
      } catch (err) {
        toast('Scrape failed: ' + err.message, 5000);
      }
    }

    /**
     * Poll CricAPI now for one match — calls the poll-cricapi edge function
     * (the same one the cron runs) and refreshes whatever's on screen. This
     * is the CricAPI-track sibling of scrapeMatchNow() above, used by the
     * Live tab's manual fetch button (see renderLiveMatchTrackControls).
     */
    async function pollMatchNow(matchId) {
      try {
        const supabaseUrl = state.db._supabaseUrl?.() ?? '';
        const anonKey     = state.db._anonKey?.() ?? '';
        const edgeFnUrl   = supabaseUrl.replace('.supabase.co', '.supabase.co/functions/v1') + '/poll-cricapi';
        const res = await fetch(edgeFnUrl, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
          body   : JSON.stringify({ matchId }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? 'Poll failed');
        const r = json.results?.[0];
        if (r?.status === 'ok') {
          toast(`📡 Polled CricAPI — ${r.matched} player${r.matched===1?'':'s'} scored. ` +
            `Unmatched: ${r.unmatched?.length ?? 0}.` +
            (r.matchCompleted ? ' Match completed — finalized.' : ''), 5000);
          renderMatchesAdmin();
          if (state.activeMatchId === matchId || $('#matchId')?.value === state.matches.find(x => x.id===matchId)?.external_id) {
            connectLive().catch(() => {});
          }
        } else {
          toast(`Poll: ${r?.status ?? json.message ?? 'no live matches'} — ${r?.error ?? ''}`, 6000);
        }
      } catch (err) {
        toast('Poll failed: ' + err.message, 5000);
      }
    }

    /**
     * Live tab — keeps the data-source indicator + manual fetch button next
     * to the API key row in sync with whichever match is selected in
     * #matchId. Independent of whether a poller is currently connected, so
     * an admin can trigger a fresh Poll/Scrape without hitting Connect first
     * — the same actions the Schedule tab's per-row buttons offer, just in
     * the context of the Live tab. Called from setAdminTab('live') and, from
     * index.html, whenever #matchId changes or is re-defaulted.
     */
    function renderLiveMatchTrackControls() {
      const indicator = $('#liveTrackIndicator');
      const btn       = $('#liveScrapeNowBtn');
      if (!indicator || !btn) return;

      const extId = $('#matchId')?.value;
      const m     = extId ? state.matches?.find(x => x.external_id === extId) : null;

      if (!m) {
        indicator.style.display = 'none';
        btn.style.display = 'none';
        return;
      }

      const matchTournament = state.tournaments?.find(t => t.id === m.tournament_id);
      const track = resolveMatchTrack(m, matchTournament);

      indicator.style.display     = 'inline-block';
      indicator.style.borderRadius = '10px';
      indicator.style.padding      = '3px 8px';
      indicator.style.fontSize     = '11px';
      indicator.style.whiteSpace   = 'nowrap';
      if (track === 'scraper') {
        indicator.textContent = '🕷 Scraper-tracked — no API key needed';
        indicator.style.background = 'rgba(120,200,80,0.10)';
        indicator.style.border     = '1px solid rgba(120,200,80,0.4)';
        indicator.style.color      = 'rgba(100,180,60,0.95)';
      } else {
        indicator.textContent = '📡 CricAPI-tracked';
        indicator.style.background = 'rgba(80,160,255,0.10)';
        indicator.style.border     = '1px solid rgba(80,160,255,0.4)';
        indicator.style.color      = 'rgba(80,160,255,0.95)';
      }

      // Only offer a manual fetch while the match is actually in play — same
      // gate renderMatchesAdmin() uses for the Schedule tab's row Poll/Scrape.
      const isPastStart = m.start_time && new Date(m.start_time) <= new Date();
      const isInPlay = isPastStart && m.status !== 'completed' && m.status !== 'delayed'
                       && m.status !== 'abandoned' && m.status !== 'cancelled';

      if (!isInPlay || !state.db) {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = 'inline-block';
      btn.textContent = track === 'scraper' ? '🕷 Scrape now' : '📡 Poll now';
      btn.title = track === 'scraper'
        ? "Fetch this match's scorecard now from the scraper"
        : 'Poll CricAPI now for this match';
      btn.onclick = async () => {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '⏳';
        try {
          if (track === 'scraper') await scrapeMatchNow(m.id);
          else await pollMatchNow(m.id);
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      };
    }

    /**
     * Finalize dispatcher — routes to the right track instead of assuming
     * CricAPI. Used by the Schedule tab row's Finalize button and by Score
     * Audit's Finalize/Re-finalize row actions, so every "Finalize"-labeled
     * action in the admin — not just the Schedule tab row — goes to the
     * correct backend. See docs/score_audit_track_streamline_plan.md §3.2.
     *
     * Deliberately looks up the match/tournament itself (rather than trusting
     * a stale isCricApiDriven computed at render time) so it's safe to call
     * from anywhere with just a matchId — including Score Audit, which never
     * had a `track` variable in scope at all.
     */
    async function finalizeMatchRouted(matchId) {
      const m = state.matches?.find(x => x.id === matchId);
      const matchTournament = state.tournaments?.find(t => t.id === m?.tournament_id);
      const track = resolveMatchTrack(m, matchTournament);
      if (m && track === 'scraper') {
        const btn = document.querySelector(`#adminMatchesBody tr[data-id="${matchId}"] .row-finalize`);
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        await scrapeMatchNow(matchId);
        if (btn) { btn.disabled = false; btn.textContent = 'Finalize'; }
      } else {
        // cricapi track, or match not found locally (let finalizeMatchById's
        // own listMatchesNeedingFinalization lookup be the source of truth —
        // it already handles "already finalized" / "not found" gracefully).
        await finalizeMatchById(matchId);
      }
    }
    // Console shortcut: window.__recalcMatch('match-uuid-here')
    window.__recalcMatch = finalizeMatchRouted;

    /**
     * Bulk finalize — processes every completed match that still needs stats.
     * Each match costs one CricAPI call (or zero if the scorecard is cached).
     */
    async function finalizeCompletedMatches() {
      const apiKey = $('#apiKey').value.trim();
      if (!apiKey) { toast('Enter your CricAPI key in Settings first.', 4000); return; }
      if (!state.db) { toast('Connect to the database first.', 4000); return; }

      const btn = $('#finalizeMatchesBtn');
      const statusEl = $('#syncStatus');
      btn.disabled = true;

      try {
        const pending = await state.db.listMatchesNeedingFinalization(state.activeTournamentId);
        if (!pending.length) {
          statusEl.textContent = 'Nothing to finalize — every completed match already has player_match_stats.';
          toast('Nothing to finalize.');
          return;
        }

        // Bulk finalize is CricAPI-only for now — scraper-tracked matches are
        // skipped here (with a note), not looped through scrape-scorecard,
        // since that edge function wasn't designed to be hammered N times in
        // a tight client-side loop the way finalizeOneMatch is. Use the
        // Schedule tab's per-row Finalize/Scrape for those instead. See
        // docs/score_audit_track_streamline_plan.md §3.4/§7.
        const activeTournament = (state.tournaments || []).find(t => t.id === state.activeTournamentId);
        const cricapiPending  = pending.filter(m => resolveMatchTrack(m, activeTournament) === 'cricapi');
        const scraperSkipped  = pending.filter(m => resolveMatchTrack(m, activeTournament) === 'scraper');

        if (!cricapiPending.length) {
          statusEl.textContent = `Nothing to bulk-finalize — all ${pending.length} pending match${pending.length===1?'':'es'} `
            + `${pending.length===1?'is':'are'} scraper-tracked. Use the Schedule tab's row-level Finalize/Scrape for ${pending.length===1?'it':'them'}.`;
          toast('Nothing to bulk-finalize — pending matches are scraper-tracked.', 6000);
          return;
        }

        const apiNeeded = cricapiPending.filter(m => !m.cachedScorecard).length;
        const skipNote = scraperSkipped.length
          ? ` — ${scraperSkipped.length} scraper-tracked match${scraperSkipped.length===1?'':'es'} skipped, use Schedule tab Scrape/Finalize per row`
          : '';
        statusEl.textContent = `Finalizing ${cricapiPending.length} match${cricapiPending.length===1?'':'es'}`
          + (apiNeeded < cricapiPending.length ? ` (${cricapiPending.length - apiNeeded} from cache, ${apiNeeded} from CricAPI)` : '')
          + skipNote + '…';

        const ok = [], failures = [];
        let playersTotal = 0, unmatchedTotal = 0, protectedTotal = 0;

        for (let i = 0; i < cricapiPending.length; i++) {
          const m = cricapiPending[i];
          btn.textContent = `Finalizing ${i+1} / ${cricapiPending.length}`;
          try {
            const result = await finalizeOneMatch(m, apiKey);
            ok.push(result);
            playersTotal += result.players; unmatchedTotal += result.unmatched;
            protectedTotal += result.manuallyProtected || 0;
          } catch (err) {
            const reason = err?.message || String(err);
            failures.push({ match: `M${m.match_number ?? '?'} ${m.home_team_id || '—'} vs ${m.away_team_id || '—'}`, externalId: m.external_id, reason, kind: classifyFinalizeError(reason) });
          }
        }

        const grouped = failures.reduce((acc, f) => { (acc[f.kind] = acc[f.kind] || []).push(f); return acc; }, {});
        const summary = Object.entries(grouped).map(([kind, list]) => `${list.length} ${kind}`).join(' · ');

        console.group(`Finalize results — ${ok.length} ok / ${failures.length} failed`);
        if (failures.length) {
          console.table(failures);
          console.log('Grouped:', Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.map(f => f.match)])));
        }
        console.groupEnd();
        window.__lastFinalize = { ok, failures, grouped, scraperSkipped };

        statusEl.innerHTML = `
          <strong>${ok.length}</strong> finalized · <strong>${playersTotal}</strong> player rows · <strong>${unmatchedTotal}</strong> unmatched
          ${protectedTotal ? ` · 🛡 <strong>${protectedTotal}</strong> manual correction${protectedTotal > 1 ? 's' : ''} preserved` : ''}
          ${scraperSkipped.length ? ` · <strong>${scraperSkipped.length}</strong> scraper-tracked skipped (use Schedule tab per row)` : ''}
          ${failures.length ? `<br><span style="color:var(--bad);">${failures.length} failed</span> (${escapeHtml(summary)}) — see dev console (<code>window.__lastFinalize</code>) for the full list.` : ''}
        `;

        if (failures.length) {
          let panel = $('#finalizeErrorPanel');
          if (!panel) {
            panel = document.createElement('details');
            panel.id = 'finalizeErrorPanel';
            panel.style.cssText = 'padding:8px 12px;background:rgba(248,113,113,0.06);border-radius:6px;margin-top:6px;';
            statusEl.after(panel);
          }
          panel.innerHTML = `
            <summary style="cursor:pointer;font-size:12px;color:var(--bad);font-weight:600;">${failures.length} failed — click to inspect</summary>
            <div style="margin-top:8px;font-size:11px;max-height:240px;overflow-y:auto;">
              ${failures.map(f => `
                <div style="padding:4px 0;border-bottom:1px dashed rgba(214,207,168,0.7);">
                  <strong>${escapeHtml(f.match)}</strong>
                  <span style="color:var(--accent-2);margin-left:6px;">[${f.kind}]</span>
                  <div style="color:var(--muted);margin-top:2px;">${escapeHtml(f.reason)}</div>
                </div>`).join('')}
            </div>`;
          panel.open = true;
        } else {
          $('#finalizeErrorPanel')?.remove();
        }

        renderMatchesAdmin();
        renderHistory();
        toast(`Finalized ${ok.length} — ${failures.length} failed.`
          + (scraperSkipped.length ? ` ${scraperSkipped.length} scraper-tracked skipped.` : ''));
      } catch (e) {
        statusEl.textContent = 'Finalize failed: ' + e.message;
        toast('Finalize failed: ' + e.message, 5000);
      } finally {
        btn.disabled = false; btn.textContent = 'Finalize completed';
      }
    }

    async function syncMatchesFromCricAPI() {
      const apiKey   = $('#apiKey').value.trim();
      const seriesId = $('#syncSeriesId').value.trim();
      if (!apiKey) { toast('Enter your CricAPI key in Settings first.', 4000); return; }
      if (!state.db) { toast('Connect to the database first (Settings).', 4000); return; }

      const onlyRemaining = $('#syncFilter').value === 'remaining';
      const btn = $('#syncMatchesBtn');
      const statusEl = $('#syncStatus');
      btn.disabled = true; btn.textContent = 'Syncing…';

      try {
        let target = [];
        if (seriesId) {
          statusEl.textContent = 'Fetching series schedule from CricAPI…';
          localStorage.setItem(SERIES_ID_LS, seriesId);
          // Persist to DB so this tournament always auto-fills in future
          try {
            const activeTournament = state.tournaments.find(t => t.id === state.activeTournamentId);
            if (activeTournament && activeTournament.cricapi_series_id !== seriesId) {
              await state.db.updateTournamentSeriesId(state.activeTournamentId, seriesId);
              activeTournament.cricapi_series_id = seriesId;
            }
          } catch (e) { console.warn('Could not persist series ID to DB:', e); }
          target = await fetchSeriesInfo(apiKey, seriesId);
          console.log('[sync] series_info returned', target.length, 'matches');
        } else {
          statusEl.textContent = 'Scanning /currentMatches (no series ID provided)…';
          const all = await fetchCurrentMatchesPaginated(apiKey);
          const isIPL = s => /indian premier league|\bipl\b|tata ipl/i.test(s || '');
          target = all.filter(m => isIPL(m.name) || isIPL(m.series));
          const allSeries = [...new Set(all.map(m => m.name || m.series).filter(Boolean))];
          console.log(`[sync] /currentMatches fetched ${all.length}, IPL ${target.length}; series seen:`, allSeries);
        }

        // ── Extract unique teams from teamInfo ─────────────────────────────
        // CricAPI's /series_info gives teamInfo[{shortname, name}] per match.
        // Collect all unique codes+names and upsert into the teams table so
        // the Teams tab is filled automatically.
        const teamMap = new Map(); // code → full name
        for (const item of target) {
          if (Array.isArray(item.teamInfo)) {
            for (const ti of item.teamInfo) {
              const code = aliasCricTeamCode(ti.shortname || null);
              if (code && ti.name) teamMap.set(code, ti.name);
            }
          }
        }
        let teamsUpserted = 0;
        if (teamMap.size) {
          statusEl.textContent = `Upserting ${teamMap.size} teams…`;
          try {
            const teamRows = [...teamMap.entries()].map(([id, name]) => ({ id, name }));
            teamsUpserted = await state.db.bulkUpsertTeams(teamRows);
            // Refresh local teams cache
            const freshTeams = await state.db.getTeams();
            A.TEAMS_DATA = freshTeams.map(t => ({ id: t.id, name: t.name, color: t.color, color2: t.color2 ?? null, jersey_svg: t.jersey_svg ?? null }));
          } catch (e) {
            console.warn('Team upsert failed (non-fatal):', e);
          }
        }

        // Map then optionally drop completed
        const rows = target.map(item => cricItemToMatch(item, state.activeTournamentId));
        const filtered = onlyRemaining ? rows.filter(r => r.status !== 'completed') : rows;

        if (!filtered.length) {
          statusEl.textContent = `No matches matched (${rows.length} fetched, ${rows.length - filtered.length} dropped).`;
          toast('No matches matched the filter.', 3000);
          return;
        }

        // All teams were just upserted — no more missing-team nulling needed.
        const knownTeams = new Set(teamCodes());
        const missingTeams = new Set();
        const sanitized = filtered.map(r => {
          const homeOk = !r.homeTeamId || knownTeams.has(r.homeTeamId);
          const awayOk = !r.awayTeamId || knownTeams.has(r.awayTeamId);
          if (!homeOk) missingTeams.add(r.homeTeamId);
          if (!awayOk) missingTeams.add(r.awayTeamId);
          return { ...r, homeTeamId: homeOk ? r.homeTeamId : null, awayTeamId: awayOk ? r.awayTeamId : null };
        });

        const { written, skipped } = await state.db.bulkUpsertMatches(sanitized);

        // Refresh UI
        state.matches = await state.db.listMatches(state.activeTournamentId);
        renderMatchesAdmin(); renderMatchSelector(); renderTeamsAdmin();

        const teamMsg = teamsUpserted ? ` · ${teamsUpserted} team${teamsUpserted !== 1 ? 's' : ''} saved` : '';
        const warn = missingTeams.size
          ? `. Still unknown codes (saved with NULL): ${[...missingTeams].join(', ')}` : '';
        statusEl.textContent = `Synced ${written}, skipped ${skipped}${teamMsg}${warn}`;
        toast(`Synced ${written} matches${teamMsg}${missingTeams.size ? ` — ${missingTeams.size} unknown code(s)` : ''}.`, 5000);
      } catch (e) {
        statusEl.textContent = 'Sync failed: ' + e.message;
        toast('Sync failed: ' + e.message, 5000);
      } finally {
        btn.disabled = false; btn.textContent = 'Sync from CricAPI';
      }
    }

    async function deleteMatchHandler(id) {
      const m = state.matches.find(x => x.id === id);
      const label = m ? `Match ${m.match_number} (${m.home_team_id} vs ${m.away_team_id})` : id;
      if (!confirm(`Delete ${label}? Match results saved against it will also be removed.`)) return;
      try {
        if (state.db) await state.db.deleteMatch(id);
        const idx = state.matches.findIndex(x => x.id === id);
        if (idx >= 0) state.matches.splice(idx, 1);
        if (state.activeMatchId === id) state.activeMatchId = null;
        toast('Deleted.');
        renderMatchesAdmin(); renderMatchSelector(); renderPool();
      } catch (e) { toast('Delete failed: ' + e.message, 5000); }
    }

    // Compute & save per-XI total points for a match by applying captain/VC
    // multipliers to raw_points already in player_match_stats. Idempotent.
    const XI_MULTIPLIERS = { captain: 2, vice_captain: 1.5, normal: 1 };
    async function computeAndSaveXIScoresForMatch(matchId) {
      if (!state.db || !matchId) return 0;
      // Fetch ALL daily teams for this match across all users (not just state.savedTeams
      // which is scoped to the current user). This ensures every participant's team
      // gets scored when an admin runs finalize/recalculate.
      let xis;
      try { xis = await state.db.getAllDailyTeamsForMatch(matchId); } catch (e) {
        console.error('[XI scores] getAllDailyTeamsForMatch failed:', e.message, e); return 0;
      }
      console.log(`[XI scores] match ${matchId} — found ${xis.length} team(s):`, xis.map(x => ({ id: x.id, name: x.name, players: x.playerIds.length, captain: x.captainId })));
      if (!xis.length) return 0;
      // Pull raw points per player for this match
      const stats = await state.db.getPlayerStatsForMatch(matchId);
      console.log(`[XI scores] player stats rows: ${stats.length}`, stats.slice(0,3));
      const rawByPlayer = Object.fromEntries(stats.map(s => [s.player_id, Number(s.raw_points)]));
      // Compute each XI's total, applying captain/VC multipliers
      const scores = xis.map(xi => {
        let total = 0;
        for (const pid of xi.playerIds) {
          const raw = rawByPlayer[pid] ?? 0;
          const mult = pid === xi.captainId      ? XI_MULTIPLIERS.captain
                     : pid === xi.viceCaptainId  ? XI_MULTIPLIERS.vice_captain
                     : 1;
          total += raw * mult;
        }
        const result = { userTeamId: xi.id, totalPoints: Math.round(total * 10) / 10 };
        console.log(`[XI scores] ${xi.name}: ${result.totalPoints} pts (${xi.playerIds.length} players, captain=${xi.captainId})`);
        return result;
      });
      console.log('[XI scores] upserting scores:', scores);
      let n;
      try { n = await state.db.upsertUserTeamMatchScores(matchId, scores); }
      catch (e) { console.error('[XI scores] upsertUserTeamMatchScores failed:', e.message, e); return 0; }
      console.log(`[XI scores] upserted ${n} score row(s)`);
      // Refresh local cache for rendering
      try {
        const all = await state.db.getAllUserTeamMatchScores();
        state.xiScoresByMatch = {};
        all.forEach(r => {
          state.xiScoresByMatch[r.match_id] = state.xiScoresByMatch[r.match_id] || [];
          state.xiScoresByMatch[r.match_id].push({ userTeamId: r.user_team_id, totalPoints: Number(r.total_points) });
        });
      } catch (e) { console.warn('refresh xiScoresByMatch failed', e); }
      return n;
    }

    /**
     * SL counterpart to computeAndSaveXIScoresForMatch.
     * Pulls every squad's locked XI for the match, applies captain/VC multipliers,
     * and upserts to user_match_xi_scores.
     *
     * For squads in a private league with custom scoring rules the base points are
     * recomputed from raw batting/bowling/fielding stats using those rules.
     * All other squads use the pre-computed raw_points from player_match_stats.
     * Idempotent — safe to call multiple times.
     */
    async function computeAndSaveSLScoresForMatch(matchId) {
      if (!state.db || !matchId) return 0;

      // Find the match to get its format
      const match = state.matches?.find(m => m.id === matchId);
      const fmt   = match?.format || 'T20';

      let squadXIs;
      try { squadXIs = await state.db.getAllSquadXIsForMatch(matchId); } catch (e) {
        console.warn('[SL scores] getAllSquadXIsForMatch failed:', e.message); return 0;
      }
      if (!Object.keys(squadXIs).length) return 0;

      // Full stats (batting/bowling/fielding + pre-computed raw_points) for custom-rules re-scoring
      let fullStats;
      try { fullStats = await state.db.getPlayerStatsForMatchFull(matchId); } catch (e) {
        console.warn('[SL scores] getPlayerStatsForMatchFull failed:', e.message); return 0;
      }
      const statsByPlayer = Object.fromEntries((fullStats || []).map(s => [s.player_id, s]));

      // Build a squad→contest map so we can look up per-league rules.
      // Fetched lazily per-squad and cached for the duration of this call.
      const squadContestMap = {};   // squadId → contest row (or null)
      async function getContestForSquad(squadId) {
        if (squadId in squadContestMap) return squadContestMap[squadId];
        try {
          const contestId = await state.db.getContestIdForSquad(squadId);
          const found = contestId
            ? (state.sl.contests?.find(c => c.id === contestId) ?? null)
            : null;
          squadContestMap[squadId] = found;
          return found;
        } catch { squadContestMap[squadId] = null; return null; }
      }

      // Resolve effective scoring rules for a contest (contest → tournament → defaults)
      const matchTournament = (state.tournaments || []).find(t => t.id === match?.tournament_id);
      async function rulesForContest(contest) {
        if (contest?.scoring_rules?.[fmt]) {
          const merged = { ...DEFAULT_SCORING_RULES[fmt], ...contest.scoring_rules[fmt] };
          // Same dot_ball_enabled gate as everywhere else — a contest's own
          // custom rules can't bypass the tournament's toggle.
          if (!matchTournament?.dot_ball_enabled) merged.dot_ball = 0;
          return merged;
        }
        // Tournament-level rules (already loaded into SCORING_RULES at boot,
        // and already gated by applyDotBallGate()).
        return SCORING_RULES[fmt];
      }

      // Batch-fetch all booster activations for this match in one query.
      // Per-squad queries hit RLS when scoring other users' squads — the batch
      // approach requires only a single read with the permissive read policy.
      let squadBoosterMap = {};   // squadId → booster key or null
      try {
        squadBoosterMap = await state.db.getAllBoostersForMatch(matchId);
      } catch (e) {
        console.warn('[SL scores] getAllBoostersForMatch failed, falling back to per-squad lookup:', e.message);
      }
      async function getBoosterForSquad(squadId) {
        // Use batch result if present; fall back to individual query as safety net
        if (squadId in squadBoosterMap) return squadBoosterMap[squadId] ?? null;
        try {
          const b = await state.db.getActiveBoosterForMatch(squadId, matchId);
          squadBoosterMap[squadId] = b;
          return b;
        } catch { squadBoosterMap[squadId] = null; return null; }
      }

      let totalSaved = 0;
      for (const [squadId, rows] of Object.entries(squadXIs)) {
        const contest        = await getContestForSquad(squadId);
        const hasCustom      = !!(contest?.scoring_rules?.[fmt]);
        const effectiveRules = hasCustom ? await rulesForContest(contest) : null;
        const booster        = await getBoosterForSquad(squadId);

        const scores = rows.map(r => {
          const s = statsByPlayer[r.player_id];
          const p = A.PLAYERS.find(x => x.id === r.player_id);

          // Captaincy key — booster can promote captain or VC slot
          const captaincy = r.is_captain
            ? (booster === 'triple_captain' ? 'triple_captain' : 'captain')
            : r.is_vc
              ? (booster === 'dual_captain' ? 'captain' : 'vice_captain')
              : 'normal';

          let raw;
          if (hasCustom && s !== undefined && effectiveRules) {
            // Re-score from raw stats using the league's custom rules
            const result = calculateScore({
              name      : p?.name       ?? '',
              role      : p?.role       ?? 'bat',
              is_overseas: p?.is_overseas ?? false,
              captaincy : 'normal',   // apply captaincy multiplier below
              batting   : s.batting   ?? null,
              bowling   : s.bowling   ?? null,
              fielding  : s.fielding  ?? null,
            }, fmt, effectiveRules);
            raw = result.rawPoints;
          } else {
            raw = Number(s?.raw_points ?? 0);
          }

          // Apply captaincy + booster multipliers
          const captMult = MULTIPLIERS[captaincy] || 1;
          let boosterMult = 1;
          if (booster === 'team_double')                                        boosterMult = 2;
          else if (booster === 'os_double'     &&  (p?.is_overseas ?? false))  boosterMult = 2;
          else if (booster === 'indian_double' && !(p?.is_overseas ?? false))  boosterMult = 2;
          const mult = captMult * boosterMult;

          return {
            playerId   : r.player_id,
            basePoints : raw,
            multiplier : mult,
            totalPoints: Math.round(raw * mult * 10) / 10,
          };
        });
        try {
          const n = await state.db.upsertSquadMatchScores(squadId, matchId, scores);
          totalSaved += n;
        } catch (e) {
          console.warn(`[SL scores] upsert failed for squad ${squadId}:`, e.message);
        }
      }
      return totalSaved;
    }


    /**
     * Narrow A.PLAYERS (the WHOLE active tournament's roster — every team,
     * not just the two playing today) down to just the two teams in match m.
     * fromCricAPI's resolveFielder() runs its surname-fallback tiers against
     * whatever "squad" it's given; passing the full tournament roster means
     * a fielder's raw name (e.g. "S Springer") can silently resolve against
     * — or collide with — a same-surname player on a completely different
     * team that isn't even in this match. The server-side scraper function
     * already scopes its own equivalent match to just matchTeamIds for
     * exactly this reason (see scrape-scorecard/index.ts's resolveFielderName
     * doc comment); this mirrors that here for the client-side path used by
     * Recalculate / Fantasy Scorecard / rescore / finalize. Falls back to the
     * full roster if the match has no team ids to filter by, so callers never
     * get an empty squad they didn't ask for.
     */
    function matchSquadFor(m) {
      const home = m?.home_team_id, away = m?.away_team_id;
      if (!home && !away) return A.PLAYERS;
      const teamOf = p => p.team_id || p.team;
      const scoped = A.PLAYERS.filter(p => teamOf(p) === home || teamOf(p) === away);
      return scoped.length ? scoped : A.PLAYERS;
    }

    // ─── FANTASY SCORECARD ───────────────────────────────────────────────────
    // Engine-calculated fantasy points for every player in the live match.
    // Independent of the user's XI — shows what each player WOULD score
    // (no captain/VC multiplier; that's per-team).
    /**
     * "Resolve on next data read", not "resolve immediately": for any player
     * already matched to the local pool, this panel now shows the real,
     * already-saved player_match_stats row for this match when one exists —
     * never a live fromCricAPI() guess for those players — and shows
     * "pending" for anyone without one yet, rather than a number that could
     * later turn out to have been wrong. A saved row already reflects
     * whatever the real engine (server cron or client Finalize) resolved,
     * fielding included, so there's nothing left here that can silently
     * disagree with Review's Fielding Issues queue. Trades a poll-interval's
     * worth of lag (this panel only updates as fast as the next scrape/poll
     * lands) for never showing a wrong number. See §9/§10 of
     * docs/fielding_credit_single_source_plan.md — this was a deliberate,
     * discussed decision, not a default.
     *
     * Unmatched players (batting/bowling identity not resolved to the local
     * pool at all) are a separate, unrelated concern — still shown via a live
     * fromCricAPI() guess with a Link button, same as before; that mechanism
     * was never part of the fielding-credit confusion this addresses.
     */
    async function renderFantasyScorecard() {
      const roleLabel = { wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL' };
      const view = $('#fantasyScorecardView');
      const meta = $('#fantasyScorecardMeta');
      const count = $('#fantasyScorecardCount');
      const payload = state.lastScorecard;
      if (!payload) {
        view.className = 'fsc-empty';
        view.innerHTML = 'No data yet.';
        meta.textContent = 'Connect to a live match to see fantasy points for every player.';
        count.textContent = '';
        return;
      }

      // Scope the squad to the two teams actually playing this match (see
      // matchSquadFor) instead of the whole tournament roster — otherwise a
      // fielder's raw surname can mismatch against an unrelated player on a
      // different team, silently stealing or losing fielding credit. Note:
      // this scoping only affects the informational fieldingIssues banner and
      // unmatched-player identity checks below now — actual scoring for any
      // matched player comes from saved player_match_stats, not from this.
      const externalId = $('#matchId')?.value?.trim();
      const currentMatch = externalId?.startsWith('manual:')
        ? state.matches?.find(m => m.id === externalId.slice(7))
        : state.matches?.find(m => m.external_id === externalId);
      const players = fromCricAPI(payload, matchSquadFor(currentMatch), state.format);
      const xiIds = new Set(state.selected);
      // Merge duplicate API names resolving to the same local player before
      // scoring — otherwise a misspelled fielding-only mention that only
      // resolves via a NAME_ALIASES/player_name_aliases entry (e.g. "Darron
      // Nedd" aliased to Darren Nedd) shows up as a second ghost row for the
      // same real player. Both entries "match" fine, so the unmatched-count
      // banner never flags it — the row count is just wrong. Unmatched names
      // still get their own row each, since those genuinely need a Link click.
      const { matched, unmatched: unmatchedPl } = mergeApiPlayersByLocalId(players, findLocalByName);

      // Real, saved data for this exact match — the only thing a matched
      // player's row is ever scored from now. Best-effort: a fetch failure
      // just means everyone shows "pending" this render, self-corrects next
      // poll tick.
      let savedByPlayerId = new Map();
      if (currentMatch && state.db) {
        try {
          const saved = await state.db.getPlayerStatsForMatchFull(currentMatch.id);
          savedByPlayerId = new Map(saved.map(s => [s.player_id, s]));
        } catch (e) {
          console.warn('[renderFantasyScorecard] could not load saved stats — showing pending for matched players this render:', e.message);
        }
      }

      const matchedScored = matched.map(({ local }) => {
        const savedRow = savedByPlayerId.get(local.id);
        if (!savedRow) {
          return {
            apiName: local.name, role: local.role, localPlayer: local,
            inXi: xiIds.has(local.id), points: null, breakdown: null, pending: true,
          };
        }
        // Use the local DB role, not the API-derived role — same reasoning
        // as finalizeOneMatch: fromCricAPI promotes anyone who both batted
        // AND bowled to 'ar', wrongly triggering the duck penalty for
        // specialist bowlers who bat lower-order.
        const s = calculateScore({
          name: local.name, role: local.role, captaincy: 'normal',
          batting: savedRow.batting, bowling: savedRow.bowling, fielding: savedRow.fielding,
        }, state.format);
        return {
          apiName: local.name,
          role: local.role,
          localPlayer: local,
          inXi: xiIds.has(local.id),
          points: s.rawPoints,
          breakdown: s.breakdown,
          pending: false,
        };
      });
      const unmatchedScored = unmatchedPl.map(pl => {
        const s = calculateScore({ ...pl, captaincy: 'normal' }, state.format);
        return {
          apiName: pl.name,
          role: pl.role,
          localPlayer: null,
          inXi: false,
          points: s.rawPoints,
          breakdown: s.breakdown,
          pending: false,
        };
      });
      // Pending rows (points === null) sort to the bottom, same tier as each
      // other, without being confused for a genuine zero-point performance.
      const scored = [...matchedScored, ...unmatchedScored]
        .sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity));

      const pendingCount = matchedScored.filter(r => r.pending).length;
      count.textContent = scored.length ? `(${scored.length})` : '';
      meta.textContent = `Match: ${payload.data?.matchInfo?.name || payload.data?.status || ''}`
        + (pendingCount ? ` · ${pendingCount} player${pendingCount > 1 ? 's' : ''} pending next save` : '');

      if (!scored.length) {
        view.className = 'fsc-empty';
        view.innerHTML = 'Scorecard arrived but contains no player rows yet.';
        return;
      }

      const unmatchedCount = scored.filter(r => !r.localPlayer).length;
      const fieldingIssues = players.fieldingIssues || [];

      view.className = 'fsc-wrap';
      view.innerHTML = `
        ${unmatchedCount ? `<div style="padding:6px 10px;font-size:11px;background:rgba(248,113,113,0.08);border-bottom:1px solid var(--border);color:var(--bad);">
          ${unmatchedCount} player${unmatchedCount>1?'s':''} not matched to your pool — click <strong>Link</strong> on the red rows to fix names &amp; recalculate points.
        </div>` : ''}
        ${fieldingIssues.length ? `<div style="padding:6px 10px;font-size:11px;background:rgba(248,113,113,0.08);border-bottom:1px solid var(--border);color:var(--bad);">
          ⚠ ${fieldingIssues.length} fielding event${fieldingIssues.length>1?'s':''} this live preview couldn't match locally. This panel is a live preview, not the source of truth for fielding credit — check <strong>Review → 🥎 Fielding Issues</strong> for what's actually unresolved (it reads the real saved data).
        </div>` : ''}
        <table class="fsc-table">
          <thead>
            <tr>
              <th class="name">Player</th>
              <th>Team</th>
              <th>Role</th>
              <th>Pts</th>
              ${unmatchedCount ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${scored.map((r, i) => {
              const colSpan = unmatchedCount ? 5 : 4;
              if (r.pending) return `
              <tr class="fsc-player-row-pending" title="No player_match_stats saved for this match yet — will show real points once the next scrape/poll lands.">
                <td class="name">${escapeHtml(r.apiName)}</td>
                <td class="team-tag">${r.localPlayer.team_id || r.localPlayer.team || '—'}</td>
                <td>${roleLabel[r.role] || r.role}</td>
                <td class="pts" style="color:var(--muted);font-style:italic;">pending</td>
                ${unmatchedCount ? '<td></td>' : ''}
              </tr>`;
              const bdText = Object.entries(r.breakdown).map(([cat, vals]) => {
                const items = Object.entries(vals).filter(([,v]) => v !== 0).map(([k,v]) => `${k}: ${v>0?'+':''}${v}`).join(', ');
                return items ? `<span class="b-cat">${cat}</span>${items}` : '';
              }).filter(Boolean).join(' &nbsp;|&nbsp; ') || '<em style="color:var(--muted)">no events scored</em>';
              if (r.localPlayer) return `
              <tr class="fsc-player-row ${r.inXi?'mine':''}" style="cursor:pointer;" data-fsc-idx="${i}">
                <td class="name">${escapeHtml(r.apiName)}</td>
                <td class="team-tag">${r.localPlayer.team_id || r.localPlayer.team || '—'}</td>
                <td>${roleLabel[r.role] || r.role}</td>
                <td class="pts">${r.points.toFixed(1)}</td>
                ${unmatchedCount ? '<td></td>' : ''}
              </tr>
              <tr class="fsc-breakdown-row" data-fsc-for="${i}" style="display:none;">
                <td colspan="${colSpan}" style="padding:4px 12px 8px;font-size:11px;color:var(--fg);background:var(--panel-2);border-bottom:1px solid var(--border);">${bdText}</td>
              </tr>`;
              return `
              <tr class="unmatched" data-api-name="${escapeHtml(r.apiName)}" data-idx="${i}">
                <td class="name">${escapeHtml(r.apiName)}</td>
                <td class="team-tag">—</td>
                <td>${roleLabel[r.role] || r.role}</td>
                <td class="pts" style="color:var(--muted);">${r.points.toFixed(1)}</td>
                <td class="link-cell">
                  <button class="link-btn">Link</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;

      // Wire Link buttons via addEventListener — onclick attributes don't work in module scripts
      view.querySelectorAll('.link-btn').forEach(btn => {
        btn.addEventListener('click', () => expandLinkRow(btn));
      });

      // No fielding-issue action controls here anymore — this panel is a live
      // preview, not the source of truth, and its own client-side name
      // matching could disagree with what's actually saved (see
      // docs/fielding_credit_single_source_plan.md). Resolving a genuinely
      // unmatched fielding credit now always happens in Review → 🥎 Fielding
      // Issues, which reads the real persisted queue.

      // Click a player row → toggle breakdown detail row
      view.querySelectorAll('.fsc-player-row').forEach(tr => {
        tr.addEventListener('click', () => {
          const idx = tr.dataset.fscIdx;
          const detail = view.querySelector(`.fsc-breakdown-row[data-fsc-for="${idx}"]`);
          if (!detail) return;
          const open = detail.style.display !== 'none';
          detail.style.display = open ? 'none' : '';
          tr.style.background = open ? '' : 'rgba(201,168,76,0.05)';
        });
      });
    }

    /**
     * fieldingIssueRowHtml/expandFieldingLinkRow (the old per-row "Credit to X"
     * / "Link" controls in this panel) were removed — this panel is a live
     * preview, not the source of truth for fielding credit, and offering an
     * action here let its own client-side matching quietly disagree with what
     * was actually saved. See docs/fielding_credit_single_source_plan.md.
     * Resolving a genuinely unmatched fielding credit now always happens in
     * Review → 🥎 Fielding Issues (see db.js's getFieldingIssues/
     * resolveFieldingIssueAsCredit and the Review-tab rendering in index.html
     * around getFieldingIssues(tid)), which reads the real persisted queue
     * instead of re-guessing.
     */

    /**
     * Expands the "Link" button into an inline player-picker.
     * Reads the API name from the row's data-api-name attribute — no fragile
     * string arguments, so names with apostrophes / special chars work fine.
     */
    function expandLinkRow(btn) {
      const tr  = btn.closest('tr');
      const td  = btn.closest('td');
      const apiName = tr.dataset.apiName;   // set as a proper data attribute, safe from escaping issues
      if (!apiName) return;

      const playerOpts = A.PLAYERS
        .slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.team_id || p.team || '')})</option>`)
        .join('');

      td.innerHTML = `
        <div class="link-inline">
          <select class="link-sel">${playerOpts}</select>
          <button class="link-save-btn">Save &amp; rescore</button>
          <button class="link-cancel-btn" style="background:transparent;border-color:var(--muted);color:var(--muted);">✕</button>
        </div>`;

      // Wire buttons via JS — no inline onclick strings needed
      td.querySelector('.link-save-btn').addEventListener('click', () => {
        const playerId = td.querySelector('.link-sel').value;
        linkPlayerAndRescore(apiName, playerId);
      });
      td.querySelector('.link-cancel-btn').addEventListener('click', () => renderFantasyScorecard());
    }

    /**
     * Links an unmatched API player name to a local player. Stores the alias in
     * two places: (1) localStorage + in-memory NAME_ALIASES, for an instant effect
     * in this browser tab, and (2) the DB-backed player_name_aliases table
     * (source='cricapi'), so the server-side poll-cricapi cron also picks it up on
     * its next run — this is the one piece of CricAPI name-matching that still
     * needs a human, so it has to actually reach the database, not just this tab.
     */
    async function linkPlayerAndRescore(apiName, playerId) {
      if (!playerId) { toast('Pick a player first.'); return; }

      const localPlayer = A.PLAYERS.find(p => p.id === playerId);
      if (!localPlayer) { toast('Player not found.'); return; }

      // CricAPI's own generic "couldn't identify this player" placeholder
      // (e.g. "Player Not Found") can't be linked to one real player — the
      // same literal string recurs for different actual players across
      // matches, so a static alias here would silently mis-credit stats to
      // whoever was picked. (This is exactly how "Player Not Found" ended up
      // permanently aliased to Abayanga Khaka.)
      if (state.db?.isPlaceholderName?.(apiName)) {
        toast(`"${apiName}" is a generic placeholder from the API, not a real name — it can't be linked to one player.`, 4000);
        return;
      }

      try {
        // 1. Store alias: apiName (lowercase) → local player name
        const key = apiName.toLowerCase().trim();
        NAME_ALIASES[key] = localPlayer.name;
        const saved = JSON.parse(localStorage.getItem('cricapi_name_aliases') || '{}');
        saved[key] = localPlayer.name;
        localStorage.setItem('cricapi_name_aliases', JSON.stringify(saved));

        // 2. Persist server-side so poll-cricapi's cron resolves it too, not just this tab.
        const externalId = $('#matchId')?.value?.trim();
        const localMatch = state.matches.find(m => m.external_id === externalId);
        if (state.db && localMatch?.tournament_id) {
          try {
            await state.db.upsertNameAlias(playerId, localMatch.tournament_id, apiName, 'cricapi');
          } catch (aliasErr) {
            console.warn('[linkPlayerAndRescore] DB alias upsert failed (browser-local alias still applied):', aliasErr.message);
          }
        }

        toast(`Linked "${apiName}" → "${localPlayer.name}". Rescoring…`, 3000);

        // 3. Rescore the current match with the updated alias in effect
        if (state.db) await rescoreCurrentMatch();
        else renderFantasyScorecard(); // local mode: just re-render

      } catch (e) {
        toast('Link failed: ' + e.message, 5000);
      }
    }

    /**
     * Re-runs fantasy scoring for the currently connected match using
     * state.lastScorecard. Saves player_match_stats + recomputes XI totals.
     */
    async function rescoreCurrentMatch() {
      if (!state.lastScorecard) { toast('No scorecard loaded.'); return; }
      if (!state.db)            { toast('Connect a database first.'); return; }

      const externalId = $('#matchId')?.value?.trim();
      const localMatch = state.matches.find(m => m.external_id === externalId);
      if (!localMatch) { toast('Match not found in DB — sync first.'); return; }

      const apiPlayers = fromCricAPI(state.lastScorecard, matchSquadFor(localMatch), state.format);
      // Merge (not skip) duplicate API names resolving to the same local
      // player — see mergeApiPlayersByLocalId. Mirrors finalizeOneMatch's guard,
      // but merges instead of dropping whichever entry lost the race.
      const { matched, unmatched: unmatchedPl3 } = mergeApiPlayersByLocalId(apiPlayers, findLocalByName);
      const unmatchedNames = unmatchedPl3.map(p => p.name);
      const rows = matched.map(({ local, pl }) => {
        // Use the local DB role, not the API-derived role — see
        // finalizeOneMatch's comment; fromCricAPI promotes any
        // batted-and-bowled player to 'ar', which wrongly triggers the duck
        // penalty for specialist bowlers.
        const s = calculateScore({ ...pl, role: local.role, captaincy: 'normal' }, state.format);
        return {
          playerId : local.id,
          batting  : pl.batting  ?? null,
          bowling  : pl.bowling  ?? null,
          fielding : pl.fielding ?? null,
          rawPoints: s.rawPoints,
        };
      });

      if (!rows.length) {
        toast(`Still no matching players (${unmatchedNames.length} unmatched). Check player names.`, 4000);
        return;
      }
      if (unmatchedNames.length) {
        const list = unmatchedNames.map(n => `"${n}"`).join(', ');
        toast(`Rescored — but ${unmatchedNames.length} still unmatched: ${list}. Link them and rescore again.`, 6000);
      }

      const n = await state.db.bulkUpsertPlayerMatchStats(localMatch.id, rows);
      const xiSaved = await computeAndSaveXIScoresForMatch(localMatch.id);
      await computeAndSaveSLScoresForMatch(localMatch.id);

      // Refresh live stats in state.stats so both daily and SL panels update
      // (use the merged rows, not raw apiPlayers, so this reflects the same
      // combined batting/bowling/fielding that just got saved).
      matched.forEach(({ local, pl }) => {
        state.stats[local.id] = { batting: pl.batting, bowling: pl.bowling, fielding: pl.fielding };
      });

      // Also persist live SL scores from updated state.stats
      if (state.mode === 'season_long') persistLiveSlScores(localMatch.id).catch(() => {});

      renderFantasyScorecard();
      renderScorecard();
      render();
      if (state.mode === 'season_long') { renderSlXiTab(); renderSlLiveTab(); }
      renderMatchesAdmin();
      toast(`Rescored: ${n} player rows saved, ${unmatchedNames.length} still unmatched${xiSaved ? `, ${xiSaved} XI total${xiSaved===1?'':'s'} updated` : ''}.`);
    }

    async function saveFantasyScorecard() {
      if (!state.db) { toast('Connect a database first (Settings).'); return; }
      if (!state.lastScorecard) { toast('Connect to a live match first.'); return; }

      // Find the local match row by the CricAPI external_id we connected with
      const matchSel = $('#matchId');
      const externalId = matchSel?.value?.trim();
      if (!externalId) { toast('No match selected.'); return; }
      const localMatch = state.matches.find(m => m.external_id === externalId);
      if (!localMatch) { toast('Selected match isn\'t in your DB. Run sync first.'); return; }

      try {
        const players = fromCricAPI(state.lastScorecard, matchSquadFor(localMatch), state.format);
        // Only persist rows whose API name maps to a local player (FK requirement).
        // Merge (not skip) by local player ID for the same reason as
        // rescoreCurrentMatch/finalizeOneMatch — two CricAPI names resolving
        // to the same local player used to collide in the ON CONFLICT batch
        // upsert, and skipping the second one silently dropped its stats.
        const { matched, unmatched: unmatchedPl4 } = mergeApiPlayersByLocalId(players, findLocalByName);
        const unmatched = unmatchedPl4.length;
        const rows = matched.map(({ local, pl }) => {
          // Use the local DB role, not the API-derived role — see
          // finalizeOneMatch's comment; fromCricAPI promotes any
          // batted-and-bowled player to 'ar', which wrongly triggers the
          // duck penalty for specialist bowlers.
          const s = calculateScore({ ...pl, role: local.role, captaincy: 'normal' }, state.format);
          return {
            playerId  : local.id,
            batting   : pl.batting   ?? null,
            bowling   : pl.bowling   ?? null,
            fielding  : pl.fielding  ?? null,
            rawPoints : s.rawPoints,
          };
        });
        if (!rows.length) {
          toast(`Nothing to save — ${unmatched} player(s) couldn\'t be matched to your DB.`, 4000);
          return;
        }
        const n = await state.db.bulkUpsertPlayerMatchStats(localMatch.id, rows);
        // Cascade: compute per-XI totals so daily + SL scores stay in sync.
        const xiSaved = await computeAndSaveXIScoresForMatch(localMatch.id);
        await computeAndSaveSLScoresForMatch(localMatch.id);
        renderMatchesAdmin();
        toast(`Saved ${n} player score${n===1?'':'s'}${unmatched?` (${unmatched} unmatched)`:''}${xiSaved?`, ${xiSaved} XI total${xiSaved===1?'':'s'} updated`:''}.`);
      } catch (e) { toast('Save failed: ' + e.message, 5000); }
    }


    // ─── TEAMS ADMIN ─────────────────────────────────────────────────────────
    function nextTeamCode() {
      // Suggest a 2–4 letter free code. Default to "T" + index.
      const used = new Set(teamCodes());
      for (let i = 1; i < 1000; i++) {
        const c = 'T' + i;
        if (!used.has(c)) return c;
      }
      return 'TEAM';
    }

    function renderTeamsAdmin() {
      // Derive which teams belong to the active tournament from its match list.
      // Falls back to all teams if no matches are loaded yet.
      const tournamentTeamIds = new Set();
      state.matches.forEach(m => {
        if (m.home_team_id) tournamentTeamIds.add(m.home_team_id);
        if (m.away_team_id) tournamentTeamIds.add(m.away_team_id);
      });
      const allTeams = [...A.TEAMS_DATA].sort((a, b) => a.id.localeCompare(b.id));
      const teams    = tournamentTeamIds.size > 0
        ? allTeams.filter(t => tournamentTeamIds.has(t.id))
        : allTeams;

      const playerCounts = {};
      A.PLAYERS.forEach(p => { playerCounts[p.team] = (playerCounts[p.team]||0)+1; });

      // Context label
      const activeTournament = state.tournaments.find(t => t.id === state.activeTournamentId);
      const contextLabel = activeTournament
        ? `<div style="font-size:11px; color:var(--muted); padding:6px 12px 0;
                       font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">
             ${escapeHtml(activeTournament.name)} — ${teams.length} team${teams.length !== 1 ? 's' : ''}
             ${tournamentTeamIds.size === 0 ? '<span style="color:var(--accent); font-weight:400;">(no matches synced yet — showing all)</span>' : ''}
           </div>`
        : '';

      const addRow = `
        <tr class="add-row" id="addTeamRow">
          <td class="col-id"><input data-f="id" type="text" value="${nextTeamCode()}" maxlength="6" style="text-transform:uppercase;" /></td>
          <td><input data-f="name" type="text" placeholder="Team name" /></td>
          <td class="col-color"><input data-f="color" type="color" value="#22d3ee" /></td>
          <td class="col-color2"><input data-f="color2" type="color" value="#ffffff" /></td>
          <td class="col-jersey" style="color:var(--muted); font-size:11px;">— (save team first)</td>
          <td class="col-actions"><button class="row-add" id="addTeamBtn" title="Add">+</button></td>
        </tr>
      `;
      const rows = teams.map(t => `
        <tr data-id="${t.id}">
          <td class="col-id"><span class="team-swatch" style="background:${t.color || '#666'}"></span>${t.id}</td>
          <td><input data-f="name" type="text" value="${escapeHtml(t.name)}" /></td>
          <td class="col-color"><input data-f="color" type="color" value="${t.color || '#666666'}" /></td>
          <td class="col-color2"><input data-f="color2" type="color" value="${t.color2 || '#ffffff'}" title="Secondary color (sleeves/collar)" /></td>
          <td class="col-jersey"><button class="jersey-svg-btn${t.jersey_svg ? ' has-asset' : ''}" data-act="jersey-toggle" title="Custom jersey SVG">${t.jersey_svg ? '🎨 custom' : '🎨 add'}</button></td>
          <td class="col-actions"><button class="row-del" data-act="del" title="Delete">×</button><span style="font-size:10px; color:var(--muted); margin-left:6px;">${playerCounts[t.id] || 0} pl</span></td>
        </tr>
        <tr class="jersey-svg-row" data-jersey-id="${t.id}" style="display:none;">
          <td colspan="6">
            <div style="display:flex; gap:10px; align-items:flex-start; padding:8px 0;">
              <div class="jersey-svg-preview" data-jersey-preview></div>
              <div style="flex:1;">
                <textarea data-jersey-input placeholder="Paste full custom jersey SVG markup here (viewBox 0 0 141 179). Leave blank and Save to clear — falls back to Color 1/2 fill.">${escapeHtml(t.jersey_svg || '')}</textarea>
                <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                  <button class="ctrl-btn ctrl-btn-admin jersey-svg-save" style="font-size:12px;">Save</button>
                  <span class="jersey-svg-status" style="font-size:11px; color:var(--muted);"></span>
                </div>
              </div>
            </div>
          </td>
        </tr>
      `).join('');

      // Inject context label above the table
      const teamsView = $('#adminTeamsView');
      let labelEl = teamsView.querySelector('#teamsContextLabel');
      if (!labelEl) {
        labelEl = document.createElement('div');
        labelEl.id = 'teamsContextLabel';
        teamsView.insertBefore(labelEl, teamsView.firstChild);
      }
      labelEl.innerHTML = contextLabel;

      $('#adminTeamsBody').innerHTML = addRow + rows;
      $('#addTeamBtn').addEventListener('click', addTeamHandler);
      $('#adminTeamsBody').querySelectorAll('tr[data-id]').forEach(tr => {
        const id = tr.dataset.id;
        tr.querySelectorAll('input').forEach(el => {
          el.addEventListener('change', () => saveTeamEdit(id, tr));
          el.addEventListener('input', () => el.classList.add('dirty'));
        });
        tr.querySelector('[data-act="del"]').addEventListener('click', () => deleteTeamHandler(id));
        tr.querySelector('[data-act="jersey-toggle"]').addEventListener('click', () => toggleJerseySvgRow(id));
      });
      $('#adminTeamsBody').querySelectorAll('tr.jersey-svg-row').forEach(tr => {
        const id = tr.dataset.jerseyId;
        renderJerseySvgPreview(tr);
        tr.querySelector('[data-jersey-input]').addEventListener('input', () => renderJerseySvgPreview(tr));
        tr.querySelector('.jersey-svg-save').addEventListener('click', () => saveJerseySvg(id, tr));
      });
      $('#adminCount').textContent = `${teams.length} team${teams.length !== 1 ? 's' : ''} · ${activeTournament?.name ?? 'all'}`;

      // ── Alias panel ──────────────────────────────────────────────────────
      renderAliasPanel();

      // ── Mismatch detection (banner now lives in the Review tab) ────────────
      renderTeamsMismatchBanner();
    }

    // Teams that appear in match schedule but have 0 players are likely
    // freshly synced from CricAPI with a different code format (e.g. "IND-W"
    // when players were imported as "INDW"). Show a fix banner — lives in
    // the Review tab's DOM, but detection depends on the active tournament's
    // matches/players, so it's re-run whenever Teams or Review tab opens.
    function renderTeamsMismatchBanner() {
      const banner = $('#teamsMismatchBanner');
      if (!banner) return;

      const tournamentTeamIds = new Set();
      state.matches.forEach(m => {
        if (m.home_team_id) tournamentTeamIds.add(m.home_team_id);
        if (m.away_team_id) tournamentTeamIds.add(m.away_team_id);
      });
      const playerCounts = {};
      A.PLAYERS.forEach(p => { playerCounts[p.team] = (playerCounts[p.team]||0)+1; });

      const playerTeamIds = Object.keys(playerCounts);
      const orphanTeams = [...tournamentTeamIds].filter(id => !(playerCounts[id] > 0));
      const suggested = orphanTeams.map(orphanId => {
        const guess = suggestTeamRemap(orphanId, playerTeamIds);
        return { from: orphanId, to: guess };
      }).filter(r => r.to !== null && r.from !== r.to);

      if (suggested.length > 0 && tournamentTeamIds.size > 0) {
        banner.style.display = 'block';
        const details = $('#teamsMismatchDetails');
        details.innerHTML = suggested.map(r =>
          `Match schedule uses <strong>${escapeHtml(r.from)}</strong> → players use <strong>${escapeHtml(r.to)}</strong>`
        ).join('<br>');
        const fixBtn = $('#fixMatchTeamsBtn');
        // Rebuild listener to avoid duplicate binds on re-render
        const newBtn = fixBtn.cloneNode(true);
        fixBtn.parentNode.replaceChild(newBtn, fixBtn);
        newBtn.addEventListener('click', () => fixMatchTeamsHandler(suggested));
      } else {
        banner.style.display = 'none';
      }
    }

    function renderAliasPanel() {
      // Read current aliases from the live map (minus the hardcoded default key)
      const savedRaw = {};
      try { Object.assign(savedRaw, JSON.parse(localStorage.getItem(CRIC_ALIAS_LS) || '{}')); } catch (e) {}
      // Also include hardcoded defaults that aren't in localStorage
      const allAliases = { ...CRIC_TEAM_CODE_MAP };

      const listEl = $('#aliasList');
      if (!listEl) return;
      listEl.innerHTML = Object.keys(allAliases).length === 0
        ? `<span style="color:var(--muted); font-size:11px;">No aliases saved yet.</span>`
        : Object.entries(allAliases).map(([from, to]) =>
            `<span style="display:inline-flex; align-items:center; gap:4px; background:var(--panel); border:1px solid var(--border); border-radius:20px; padding:3px 8px; font-size:11px;">
              <span style="color:var(--muted);">${escapeHtml(from)}</span>
              <span style="color:var(--accent);">→</span>
              <span style="color:var(--text); font-weight:600;">${escapeHtml(to)}</span>
              <button data-alias-del="${escapeHtml(from)}" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:13px;padding:0 0 0 2px;line-height:1;" title="Remove alias">×</button>
            </span>`
          ).join('');

      // Wire delete buttons (clone to avoid duplicate listeners)
      listEl.querySelectorAll('[data-alias-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          removeAlias(btn.dataset.aliasDel);
          renderAliasPanel();
          toast(`Alias "${btn.dataset.aliasDel}" removed.`, 2500);
        });
      });

      // Toggle show/hide
      const toggleBtn = $('#toggleAliasPanel');
      const body = $('#aliasPanelBody');
      if (toggleBtn && body) {
        const newToggle = toggleBtn.cloneNode(true);
        toggleBtn.parentNode.replaceChild(newToggle, toggleBtn);
        newToggle.addEventListener('click', () => {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          newToggle.textContent = open ? '▾ show' : '▴ hide';
        });
      }

      // Add alias button
      const addBtn = $('#addAliasBtn');
      if (addBtn) {
        const newAdd = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAdd, addBtn);
        newAdd.addEventListener('click', () => {
          const fromVal = ($('#aliasFrom').value || '').trim().toUpperCase();
          const toVal   = ($('#aliasTo').value || '').trim().toUpperCase();
          if (!fromVal || !toVal) { toast('Both codes are required.'); return; }
          saveAliases({ [fromVal]: toVal });
          $('#aliasFrom').value = ''; $('#aliasTo').value = '';
          renderAliasPanel();
          toast(`Alias ${fromVal} → ${toVal} saved.`, 2500);
        });
      }

      // Fix existing matches button — applies all current aliases to DB matches now
      const applyBtn = $('#applyAliasesToMatchesBtn');
      if (applyBtn) {
        const newApply = applyBtn.cloneNode(true);
        applyBtn.parentNode.replaceChild(newApply, applyBtn);
        newApply.addEventListener('click', async () => {
          if (!state.db) { toast('Connect to the database first.', 4000); return; }
          if (!state.activeTournamentId) { toast('Select a tournament first.', 4000); return; }
          const mapping = Object.entries(CRIC_TEAM_CODE_MAP)
            .filter(([from, to]) => from !== to)
            .map(([from, to]) => ({ from, to }));
          if (!mapping.length) { toast('No aliases defined — add some first.', 3000); return; }
          const statusEl = $('#applyAliasStatus');
          newApply.disabled = true; newApply.textContent = 'Applying…'; if (statusEl) statusEl.textContent = '';
          try {
            await state.db.remapMatchTeams(state.activeTournamentId, mapping);
            state.matches = await state.db.listMatches(state.activeTournamentId);
            toast(`Applied ${mapping.length} alias${mapping.length !== 1 ? 'es' : ''} to existing matches.`, 4000);
            if (statusEl) statusEl.textContent = `✓ Done ${new Date().toLocaleTimeString()}`;
            await afterTeamCodeFix();
          } catch (e) {
            toast('Failed: ' + e.message, 6000);
            if (statusEl) statusEl.textContent = '✗ ' + e.message;
            newApply.disabled = false; newApply.textContent = '⚡ Apply to existing matches';
          }
        });
      }
    }

    /** Fuzzy match an orphan match team code to the nearest player team code.
     *  Strategy: normalise both sides by stripping optional hyphen/underscore
     *  followed by a W or M gender suffix (handles both "IND-W" and "INDW"),
     *  then look for an exact or prefix match.
     */
    function suggestTeamRemap(orphanId, playerTeamIds) {
      // Strip optional separator + W/M gender suffix, then strip all non-alphanumeric
      const norm = s => s.replace(/[-_]?(w|m)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const normO = norm(orphanId);
      // 1) Exact match after normalisation (e.g. "INDW" and "IND-W" both → "ind")
      for (const pid of playerTeamIds) {
        if (norm(pid) === normO) return pid;
      }
      // 2) One is a prefix of the other
      for (const pid of playerTeamIds) {
        const normP = norm(pid);
        if (normO.startsWith(normP) || normP.startsWith(normO)) return pid;
      }
      return null;
    }

    async function fixMatchTeamsHandler(mapping) {
      const btn = $('#fixMatchTeamsBtn');
      const statusEl = $('#teamsMismatchStatus');
      if (!state.db) { toast('Connect to the database first.', 4000); return; }
      if (!state.activeTournamentId) { toast('Select a tournament first.', 4000); return; }
      btn.disabled = true; btn.textContent = 'Fixing…'; statusEl.textContent = '';
      try {
        await state.db.remapMatchTeams(state.activeTournamentId, mapping);
        // Persist aliases so future CricAPI syncs translate codes correctly at ingest time
        const newEntries = Object.fromEntries(mapping.map(r => [r.from, r.to]));
        saveAliases(newEntries);
        // Refresh local match data so home/away IDs are updated
        state.matches = await state.db.listMatches(state.activeTournamentId);
        toast(`Fixed ${mapping.length} team code${mapping.length !== 1 ? 's' : ''}. Aliases saved for future syncs.`, 5000);
        statusEl.textContent = `✓ Applied ${new Date().toLocaleTimeString()}`;
        await afterTeamCodeFix();
      } catch (e) {
        toast('Fix failed: ' + e.message, 6000);
        statusEl.textContent = '✗ ' + e.message;
        btn.disabled = false; btn.textContent = '✓ Apply Fix';
      }
    }

    async function addTeamHandler() {
      const row = $('#addTeamRow');
      const id     = row.querySelector('[data-f="id"]').value.trim().toUpperCase();
      const name   = row.querySelector('[data-f="name"]').value.trim();
      const color  = row.querySelector('[data-f="color"]').value;
      const color2 = row.querySelector('[data-f="color2"]').value || null;
      if (!id || !name) { toast('Code and name are required.'); return; }
      if (teamByCode(id)) { toast(`Code "${id}" already exists.`); return; }
      try {
        if (state.db) {
          const inserted = await state.db.addTeam({ id, name, color, color2 });
          A.TEAMS_DATA.push({ id: inserted.id, name: inserted.name, color: inserted.color, color2: inserted.color2, jersey_svg: inserted.jersey_svg ?? null });
        } else {
          A.TEAMS_DATA.push({ id, name, color, color2, jersey_svg: null });
        }
        toast(`Added ${id}.`);
        renderTeamsAdmin(); renderPool(); renderTeamFilter();
      } catch (e) { toast('Add failed: ' + e.message, 4000); }
    }

    async function saveTeamEdit(id, tr) {
      const patch = {
        name:   tr.querySelector('[data-f="name"]').value.trim(),
        color:  tr.querySelector('[data-f="color"]').value,
        color2: tr.querySelector('[data-f="color2"]').value || null,
      };
      if (!patch.name) { toast('Name is required.'); return; }
      try {
        if (state.db) {
          const upd = await state.db.updateTeam(id, patch);
          const idx = A.TEAMS_DATA.findIndex(t => t.id === id);
          if (idx >= 0) A.TEAMS_DATA[idx] = { id: upd.id, name: upd.name, color: upd.color, color2: upd.color2, jersey_svg: upd.jersey_svg ?? null };
        } else {
          const idx = A.TEAMS_DATA.findIndex(t => t.id === id);
          if (idx >= 0) A.TEAMS_DATA[idx] = { ...A.TEAMS_DATA[idx], ...patch };
        }
        tr.querySelectorAll('.dirty').forEach(el => el.classList.remove('dirty'));
        renderPool(); renderTeamFilter();
      } catch (e) { toast('Save failed: ' + e.message, 4000); }
    }

    async function deleteTeamHandler(id) {
      const t = teamByCode(id);
      if (!confirm(`Delete team "${t?.name || id}"? Players in this team must be reassigned or deleted first.`)) return;
      try {
        if (state.db) await state.db.deleteTeam(id);
        const idx = A.TEAMS_DATA.findIndex(x => x.id === id);
        if (idx >= 0) A.TEAMS_DATA.splice(idx, 1);
        if (state.filterTeam === id) state.filterTeam = 'ALL';
        toast('Deleted.');
        renderTeamsAdmin(); renderPool(); renderTeamFilter();
      } catch (e) { toast('Delete failed: ' + e.message, 5000); }
    }

    function toggleJerseySvgRow(id) {
      const tr = $(`#adminTeamsBody`).querySelector(`tr.jersey-svg-row[data-jersey-id="${CSS.escape(id)}"]`);
      if (!tr) return;
      tr.style.display = tr.style.display === 'none' ? '' : 'none';
    }

    // Live preview of the pasted SVG markup as a data-URI <img>, same shape/
    // viewBox as the app's jersey (141x179) — lets an admin sanity-check the
    // markup renders before saving. Malformed SVG just shows a blank preview,
    // no error thrown (it's a `<img>` load failure, not a JS exception).
    function renderJerseySvgPreview(tr) {
      const raw = tr.querySelector('[data-jersey-input]').value.trim();
      const preview = tr.querySelector('[data-jersey-preview]');
      if (!raw) { preview.innerHTML = '<span style="font-size:9px; color:var(--muted);">none</span>'; return; }
      const uri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(raw)));
      preview.innerHTML = `<img src="${uri}" alt="jersey preview" />`;
    }

    async function saveJerseySvg(id, tr) {
      const input = tr.querySelector('[data-jersey-input]');
      const statusEl = tr.querySelector('.jersey-svg-status');
      const jerseySvg = input.value.trim() || null;
      statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--muted)';
      try {
        if (state.db) {
          const upd = await state.db.updateTeam(id, { jerseySvg });
          const idx = A.TEAMS_DATA.findIndex(t => t.id === id);
          if (idx >= 0) A.TEAMS_DATA[idx] = { ...A.TEAMS_DATA[idx], jersey_svg: upd.jersey_svg ?? null };
        } else {
          const idx = A.TEAMS_DATA.findIndex(t => t.id === id);
          if (idx >= 0) A.TEAMS_DATA[idx] = { ...A.TEAMS_DATA[idx], jersey_svg: jerseySvg };
        }
        statusEl.textContent = `✓ Saved ${new Date().toLocaleTimeString()}`;
        statusEl.style.color = 'var(--good,#4ade80)';
        renderTeamsAdmin(); renderPool(); renderTeamFilter();
      } catch (e) {
        statusEl.textContent = 'Save failed: ' + e.message;
        statusEl.style.color = 'var(--bad)';
      }
    }


    // ─── CSV IMPORT ──────────────────────────────────────────────────────────
    // Bare-bones RFC 4180-ish CSV parser. Handles quoted fields, escaped quotes ("")
    // and trims surrounding whitespace on unquoted fields.
    function parseCSV(text) {
      const rows = [];
      let cur = []; let field = ''; let inQuote = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) {
          if (ch === '"' && text[i+1] === '"') { field += '"'; i++; }
          else if (ch === '"') { inQuote = false; }
          else { field += ch; }
        } else {
          if (ch === '"') { inQuote = true; }
          else if (ch === ',') { cur.push(field.trim()); field = ''; }
          else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i+1] === '\n') i++;
            cur.push(field.trim()); field = '';
            // Skip blank lines
            if (cur.length > 1 || (cur[0] && cur[0].length)) rows.push(cur);
            cur = [];
          }
          else { field += ch; }
        }
      }
      if (field.length || cur.length) {
        cur.push(field.trim());
        if (cur.length > 1 || (cur[0] && cur[0].length)) rows.push(cur);
      }
      return rows;
    }

    // ─── SCHEDULE CSV IMPORT ───────────────────────────────────────────────────
    // Common timezone aliases → fixed UTC offset. Cricket schedules run in
    // IST (India), US zones (MLC), and SAST (South Africa) most often — see
    // also the per-tournament "non-overseas" label feature these leagues
    // share. There's no tz-database in this app to resolve DST automatically,
    // so US zones have separate STD/DST aliases — the admin picks whichever
    // is actually in effect for the match date (e.g. ET in summer = EDT).
    const TZ_OFFSETS = {
      UTC: '+00:00', GMT: '+00:00',
      IST: '+05:30',
      SAST: '+02:00',
      BST: '+01:00',
      ET: '-05:00', EST: '-05:00', EDT: '-04:00',
      CT: '-06:00', CST: '-06:00', CDT: '-05:00',
      MT: '-07:00', MST: '-07:00', MDT: '-06:00',
      PT: '-08:00', PST: '-08:00', PDT: '-07:00',
    };

    // Accepts a named zone (e.g. "ET", "IST") or an explicit offset ("+05:30",
    // "-04:00", "Z"). Returns a normalized "+HH:MM"/"-HH:MM" string, or null.
    function resolveTzOffset(raw) {
      const v = (raw || '').trim();
      if (!v) return null;
      if (/^Z$/i.test(v)) return '+00:00';
      const named = TZ_OFFSETS[v.toUpperCase()];
      if (named) return named;
      const m = /^([+-])(\d{1,2}):?(\d{2})$/.exec(v);
      if (m) {
        const [, sign, hh, mm] = m;
        return `${sign}${hh.padStart(2, '0')}:${mm}`;
      }
      return null;
    }

    function matchesCsvTemplate() {
      return [
        'team1,team2,format,date,time,timezone',
        'MI,CSK,T20,2026-08-01,19:30,IST',
        'WF,SFU,T20,2026-08-02,19:00,ET',
      ].join('\n');
    }

    function downloadMatchesCSVTemplate() {
      const blob = new Blob([matchesCsvTemplate()], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'schedule_template.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Map a parsed schedule CSV (array of arrays, first row = header) to
    // validated row objects. Match numbers are auto-assigned in file order,
    // continuing from whatever's already used in this tournament — same
    // scheme as the single-row "add match" form's nextMatchNumber().
    function buildMatchesCsvRows(rawRows) {
      if (!rawRows.length) return { rows: [], errors: ['Empty CSV — paste some data first.'] };
      const header = rawRows[0].map(s => s.toLowerCase());
      const required = ['team1', 'team2', 'format', 'date', 'time', 'timezone'];
      const missing = required.filter(c => !header.includes(c));
      if (missing.length) return { rows: [], errors: [`CSV header is missing: ${missing.join(', ')}`] };

      const idx = {
        team1:    header.indexOf('team1'),
        team2:    header.indexOf('team2'),
        format:   header.indexOf('format'),
        date:     header.indexOf('date'),
        time:     header.indexOf('time'),
        timezone: header.indexOf('timezone'),
      };

      const usedNumbers = new Set(state.matches.map(m => m.match_number).filter(Boolean));
      let candidate = 1;
      const nextFreeNumber = () => {
        while (usedNumbers.has(candidate)) candidate++;
        usedNumbers.add(candidate);
        return candidate++;
      };

      const out = [];
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i];
        const get = k => idx[k] >= 0 ? (r[idx[k]] ?? '') : '';
        const team1  = get('team1').trim().toUpperCase();
        const team2  = get('team2').trim().toUpperCase();
        const format = get('format').trim().toUpperCase();
        const dateRaw = get('date').trim();
        const timeRaw = get('time').trim();
        const tzRaw   = get('timezone').trim();

        const row = {
          line: i + 1,
          team1, team2, format,
          date: dateRaw, time: timeRaw, timezone: tzRaw,
          matchNumber: null, startTimeIso: null, playedOn: null,
          errors: [],
        };

        if (!KNOWN_TEAMS.includes(team1)) row.errors.push(`unknown team "${team1}"`);
        if (!KNOWN_TEAMS.includes(team2)) row.errors.push(`unknown team "${team2}"`);
        if (team1 && team2 && team1 === team2) row.errors.push('team1 and team2 must differ');
        if (!['T20', 'ODI', 'TEST'].includes(format)) row.errors.push(`bad format "${format}" — must be T20, ODI or TEST`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) row.errors.push(`date must be YYYY-MM-DD, got "${dateRaw}"`);
        if (!/^\d{1,2}:\d{2}$/.test(timeRaw)) row.errors.push(`time must be HH:MM (24h), got "${timeRaw}"`);
        const offset = resolveTzOffset(tzRaw);
        if (!offset) row.errors.push(`unrecognized timezone "${tzRaw}" — use a named zone (IST, ET, CT, MT, PT, SAST, UTC…) or an offset like +05:30`);

        if (row.errors.length === 0) {
          const timePadded = timeRaw.length === 4 ? '0' + timeRaw : timeRaw; // "9:30" → "09:30"
          const parsed = new Date(`${dateRaw}T${timePadded}:00${offset}`);
          if (isNaN(parsed)) {
            row.errors.push('could not parse date/time/timezone into a valid instant');
          } else {
            row.startTimeIso = parsed.toISOString();
            row.playedOn     = row.startTimeIso.slice(0, 10);
            row.matchNumber  = nextFreeNumber();
          }
        }

        out.push(row);
      }
      return { rows: out, errors: [] };
    }

    function renderMatchesCsvPreview(rows, errors) {
      const preview   = $('#matchesCsvPreview');
      const summary   = $('#matchesCsvSummary');
      const importBtn = $('#matchesCsvImportBtn');
      if (errors.length) {
        preview.style.display = 'block';
        preview.innerHTML = `<table><tbody>${errors.map(e => `<tr class="row-err"><td>!</td><td class="err-msg">${escapeHtml(e)}</td></tr>`).join('')}</tbody></table>`;
        summary.textContent = '';
        importBtn.disabled = true; importBtn.textContent = 'Import';
        return;
      }
      const ok  = rows.filter(r => r.errors.length === 0);
      const bad = rows.filter(r => r.errors.length  >  0);

      const rowsHtml = rows.map(r => {
        const status = r.errors.length ? '✗' : '✓';
        const cls    = r.errors.length ? 'row-err' : 'row-ok';
        const errs   = r.errors.length ? `<div class="err-msg">${escapeHtml(r.errors.join('; '))}</div>` : '';
        const resolved = r.startTimeIso ? new Date(r.startTimeIso).toLocaleString() : '—';
        return `<tr class="${cls}">
          <td>${status}</td>
          <td>${r.matchNumber ?? '—'}</td>
          <td>${escapeHtml(r.team1)} vs ${escapeHtml(r.team2)}${errs}</td>
          <td>${escapeHtml(r.format)}</td>
          <td>${escapeHtml(r.date)} ${escapeHtml(r.time)} ${escapeHtml(r.timezone)}</td>
          <td>${resolved}</td>
        </tr>`;
      }).join('');

      preview.style.display = 'block';
      preview.innerHTML = `
        <table>
          <thead><tr><th></th><th>#</th><th>Match</th><th>Format</th><th>As entered</th><th>Resolved (your local time)</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
      summary.textContent = `${ok.length} ok · ${bad.length} with errors · ${rows.length} total`;
      importBtn.disabled = ok.length === 0;
      importBtn.textContent = `Import ${ok.length} row${ok.length===1?'':'s'}`;
      importBtn._rows = ok;
    }

    function openMatchesCsvView() {
      if (!state.activeTournamentId) { toast('Select a tournament first (Schedule tab context bar).', 4000); return; }
      $('#adminMatchesView').style.display = 'none';
      $('#matchesCsvView').style.display   = 'block';
    }
    function closeMatchesCsvView() {
      $('#matchesCsvView').style.display = 'none';
      $('#adminMatchesView').style.display = 'block';
      $('#matchesCsvText').value = '';
      $('#matchesCsvFile').value = '';
      $('#matchesCsvPreview').style.display = 'none';
      $('#matchesCsvPreview').innerHTML = '';
      $('#matchesCsvSummary').textContent = '';
      $('#matchesCsvImportBtn').disabled = true;
      $('#matchesCsvImportBtn').textContent = 'Import';
      $('#matchesCsvImportBtn')._rows = null;
    }

    async function matchesCsvPreviewHandler() {
      const text = $('#matchesCsvText').value;
      if (!text.trim()) { toast('Paste CSV or upload a file first.'); return; }
      const raw = parseCSV(text);
      const { rows, errors } = buildMatchesCsvRows(raw);
      renderMatchesCsvPreview(rows, errors);
    }

    async function matchesCsvFileHandler(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      $('#matchesCsvText').value = text;
      matchesCsvPreviewHandler();
    }

    async function matchesCsvImportHandler() {
      const rows = $('#matchesCsvImportBtn')._rows;
      if (!rows || rows.length === 0) { toast('Nothing valid to import.'); return; }
      if (!state.activeTournamentId) { toast('Select a tournament first.', 4000); return; }
      try {
        if (state.db) {
          const inserted = await state.db.bulkAddMatches(rows.map(r => ({
            tournamentId: state.activeTournamentId,
            matchNumber : r.matchNumber,
            format      : r.format,
            homeTeamId  : r.team1,
            awayTeamId  : r.team2,
            playedOn    : r.playedOn,
            startTime   : r.startTimeIso,
          })));
          state.matches.push(...inserted);
          toast(`Imported ${inserted.length} match${inserted.length===1?'':'es'}.`);
        } else {
          rows.forEach(r => {
            state.matches.push({
              id: 'local-' + Date.now() + '-' + r.matchNumber,
              tournament_id: state.activeTournamentId,
              match_number: r.matchNumber, format: r.format,
              home_team_id: r.team1, away_team_id: r.team2,
              played_on: r.playedOn, start_time: r.startTimeIso, status: 'scheduled',
            });
          });
          toast(`Imported ${rows.length} match${rows.length===1?'':'es'} (local mode).`);
        }
        closeMatchesCsvView();
        renderMatchesAdmin();
        renderMatchSelector();
      } catch (e) {
        toast('Import failed: ' + e.message, 6000);
      }
    }

    function csvTemplate() {
      return [
        'id,name,team,role,credits,overseas',
        'p31,Example Indian Batter,MI,bat,9.0,false',
        'p32,Example Overseas Bowler,GT,bowl,9.5,true',
        ',Auto ID Wicketkeeper,RR,wk,8.5,false',
      ].join('\n');
    }

    function downloadCSVTemplate() {
      const blob = new Blob([csvTemplate()], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'players_template.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Map a parsed CSV (array of arrays, first row = header) to validated row objects.
    function buildCsvRows(rawRows) {
      if (!rawRows.length) return { rows: [], errors: ['Empty CSV — paste some data first.'] };
      const header = rawRows[0].map(s => s.toLowerCase());
      const required = ['name','team','role','credits'];
      const missing = required.filter(c => !header.includes(c));
      if (missing.length) return { rows: [], errors: [`CSV header is missing: ${missing.join(', ')}`] };

      const idx = {
        id:       header.indexOf('id'),
        name:     header.indexOf('name'),
        team:     header.indexOf('team'),
        role:     header.indexOf('role'),
        credits:  header.indexOf('credits'),
        overseas: header.indexOf('overseas'),
      };

      const existingIds  = new Set(A.PLAYERS.map(p => p.id));
      const existingById = Object.fromEntries(A.PLAYERS.map(p => [p.id, p]));
      // Same normalization find_duplicate_players.sql uses — lets us catch a
      // name collision here, before import, instead of only finding it after
      // the fact via that diagnostic. Keyed on normalized name so "Ali Khan"
      // vs " ali  khan " still matches.
      const normName = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const existingByName = {};
      A.PLAYERS.forEach(p => { existingByName[normName(p.name)] = p; });
      const usedNewIds   = new Set();
      const rolePresets = { wicketkeeper:'wk', wk:'wk', keeper:'wk',
                            batter:'bat', batsman:'bat', bat:'bat',
                            'all-rounder':'ar', allrounder:'ar', ar:'ar',
                            bowler:'bowl', bowl:'bowl' };

      const out = [];
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i];
        const get = k => idx[k] >= 0 ? (r[idx[k]] ?? '') : '';
        const row = {
          line: i + 1,
          id:       get('id').trim(),
          name:     get('name').trim(),
          team:     get('team').trim().toUpperCase(),
          role:     rolePresets[get('role').trim().toLowerCase()] || get('role').trim().toLowerCase(),
          credits:  parseFloat(get('credits')),
          overseas: /^(true|yes|1|y)$/i.test(get('overseas').trim()),
          errors: [],
        };
        if (!row.name) row.errors.push('name is required');
        if (!KNOWN_TEAMS.includes(row.team)) row.errors.push(`unknown team "${row.team}"`);
        if (!['wk','bat','ar','bowl'].includes(row.role)) row.errors.push(`bad role "${row.role}"`);
        if (!Number.isFinite(row.credits) || row.credits < 0) row.errors.push('credits must be a non-negative number');

        // Name collision with an EXISTING player under a different id — the
        // real bug this closes. Neither the blank-id auto-assign path nor a
        // typed id was ever checked against existing NAMES, only existing
        // ids, so importing a roster for someone already in the system (e.g.
        // a slightly different id scheme, or the admin not knowing their id)
        // silently created a second row for the same real person instead of
        // mapping to the one that's actually used elsewhere (tournament
        // rosters, saved XIs, scored stats). Flag it here so the admin picks
        // the existing id explicitly instead of getting a duplicate by
        // default — see find_duplicate_players.sql for cleaning up ones that
        // already slipped through before this check existed.
        const nameMatch = row.name ? existingByName[normName(row.name)] : null;
        const isNameCollision = nameMatch && nameMatch.id !== row.id;

        if (!row.id) {
          if (isNameCollision) {
            row.errors.push(`name matches existing player "${nameMatch.name}" (id "${nameMatch.id}") — set id to "${nameMatch.id}" to update them, or use a different name if this is really someone else`);
          } else {
            // Auto-assign smallest free pNN, accounting for IDs already chosen earlier in this batch
            const used = new Set([...existingIds, ...usedNewIds]);
            for (let n = 1; n < 1000; n++) {
              const candidate = 'p' + String(n).padStart(2, '0');
              if (!used.has(candidate)) { row.id = candidate; usedNewIds.add(candidate); break; }
            }
          }
        } else {
          if (usedNewIds.has(row.id)) {
            row.errors.push(`duplicate id "${row.id}" in this CSV`);
          } else if (existingById[row.id] && existingById[row.id].name !== row.name) {
            // ID already belongs to a different player in the DB — would silently overwrite them
            row.errors.push(`id "${row.id}" already used by "${existingById[row.id].name}" — choose a different id or leave blank to auto-assign`);
          } else if (isNameCollision) {
            row.errors.push(`name matches existing player "${nameMatch.name}" under a DIFFERENT id ("${nameMatch.id}") — use "${nameMatch.id}" to update them, or use a different name if this is really someone else`);
          }
          usedNewIds.add(row.id);
        }
        out.push(row);
      }
      return { rows: out, errors: [] };
    }

    function renderCsvPreview(rows, errors) {
      const preview = $('#csvPreview');
      const summary = $('#csvSummary');
      const importBtn = $('#csvImportBtn');
      if (errors.length) {
        preview.style.display = 'block';
        preview.innerHTML = `<table><tbody>${errors.map(e => `<tr class="row-err"><td>!</td><td class="err-msg">${escapeHtml(e)}</td></tr>`).join('')}</tbody></table>`;
        summary.textContent = '';
        importBtn.disabled = true; importBtn.textContent = 'Import';
        return;
      }
      const ok  = rows.filter(r => r.errors.length === 0);
      const bad = rows.filter(r => r.errors.length  >  0);

      const rowsHtml = rows.map(r => {
        const status = r.errors.length ? '✗' : '✓';
        const cls    = r.errors.length ? 'row-err' : 'row-ok';
        const errs   = r.errors.length ? `<div class="err-msg">${escapeHtml(r.errors.join('; '))}</div>` : '';
        return `<tr class="${cls}">
          <td>${status}</td>
          <td>${r.id || '—'}</td>
          <td>${escapeHtml(r.name)}${errs}</td>
          <td>${escapeHtml(r.team)}</td>
          <td>${escapeHtml(r.role)}</td>
          <td>${Number.isFinite(r.credits) ? r.credits : ''}</td>
          <td>${r.overseas ? '✈️' : ''}</td>
        </tr>`;
      }).join('');

      preview.style.display = 'block';
      preview.innerHTML = `
        <table>
          <thead><tr><th></th><th>ID</th><th>Name</th><th>Team</th><th>Role</th><th>Credits</th><th>✈️</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
      summary.textContent = `${ok.length} ok · ${bad.length} with errors · ${rows.length} total`;
      importBtn.disabled = ok.length === 0;
      importBtn.textContent = `Import ${ok.length} row${ok.length===1?'':'s'}`;
      // Store the parsed rows on the button for the import handler to read
      importBtn._rows = ok;
    }

    function openCsvView() {
      $('#adminTableView').style.display = 'none';
      $('#adminCsvView').style.display = 'block';
    }
    function closeCsvView() {
      $('#adminCsvView').style.display = 'none';
      $('#adminTableView').style.display = 'block';
      $('#csvText').value = '';
      $('#csvFile').value = '';
      $('#csvPreview').style.display = 'none';
      $('#csvPreview').innerHTML = '';
      $('#csvSummary').textContent = '';
      $('#csvImportBtn').disabled = true;
      $('#csvImportBtn').textContent = 'Import';
      $('#csvImportBtn')._rows = null;
    }

    async function csvPreviewHandler() {
      const text = $('#csvText').value;
      if (!text.trim()) { toast('Paste CSV or upload a file first.'); return; }
      const raw = parseCSV(text);
      const { rows, errors } = buildCsvRows(raw);
      renderCsvPreview(rows, errors);
    }

    async function csvFileHandler(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      $('#csvText').value = text;
      csvPreviewHandler();
    }

    async function csvImportHandler() {
      const rows = $('#csvImportBtn')._rows;
      if (!rows || rows.length === 0) { toast('Nothing valid to import.'); return; }
      try {
        if (state.db) {
          const n = await state.db.bulkUpsertPlayers(rows);
          // Also update tournament-specific team + credits when a tournament is active.
          // Silently skipped if the v2 migration hasn't been run yet (table won't exist).
          if (state.activeTournamentId) {
            try {
              await state.db.bulkUpsertTournamentPlayers(
                state.activeTournamentId,
                rows.map(r => ({ playerId: r.id, teamId: r.team, creditValue: r.credits, isActive: true, isOverseas: !!r.overseas }))
              );
              A.PLAYERS = await state.db.getPlayersForTournament(state.activeTournamentId);
              if (!A.PLAYERS.length) A.PLAYERS = await state.db.getPlayers();
            } catch (e) {
              // tournament_players table not yet created (run migration_v2 to enable this)
              console.info('tournament_players not available, using global players.', e.message);
              A.PLAYERS = await state.db.getPlayers();
            }
          } else {
            A.PLAYERS = await state.db.getPlayers();
          }
          toast(`Imported ${n} player${n===1?'':'s'}.`);
        } else {
          // Local-mode: upsert into in-memory A.PLAYERS
          rows.forEach(r => {
            const idx = A.PLAYERS.findIndex(p => p.id === r.id);
            const next = { id:r.id, name:r.name, team:r.team, role:r.role, credits:r.credits, overseas:!!r.overseas };
            if (idx >= 0) A.PLAYERS[idx] = next; else A.PLAYERS.push(next);
          });
          toast(`Imported ${rows.length} (local mode — not persisted).`);
        }
        refreshAllPlayerIds(); // CSV import can add new global player ids via bulkUpsertPlayers
        closeCsvView();
        renderAdmin(); renderPool(); render();
      } catch (e) { toast('Import failed: ' + e.message, 5000); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Player photos — pastes the CSV produced by import_player_photos.py
    // (name, cricinfo_id, team, photo_url, status) and writes photo_url
    // onto the matching global players row. Separate flow from the roster
    // CSV above: this never creates new players, only matches by name
    // against the ones already imported, and classifies each row as
    // new / update / unmatched so overwriting an existing photo is visible
    // before you commit to it, not a silent side effect.
    // ─────────────────────────────────────────────────────────────────────

    function openPhotoCsvView() {
      $('#adminTableView').style.display = 'none';
      $('#adminPhotoCsvView').style.display = 'block';
    }
    function closePhotoCsvView() {
      $('#adminPhotoCsvView').style.display = 'none';
      $('#adminTableView').style.display = 'block';
      $('#photoCsvText').value = '';
      $('#photoCsvFile').value = '';
      $('#photoCsvPreview').style.display = 'none';
      $('#photoCsvPreview').innerHTML = '';
      $('#photoCsvSummary').textContent = '';
      $('#photoCsvImportBtn').disabled = true;
      $('#photoCsvImportBtn').textContent = 'Import';
      $('#photoCsvImportBtn')._rows = null;
    }

    // Same normalization buildCsvRows() uses for the roster CSV's name
    // collision check — keyed on normalized name so "Ali Khan" vs
    // " ali  khan " still matches.
    const normPlayerName = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

    function buildPhotoCsvRows(rawRows) {
      if (!rawRows.length) return { rows: [], errors: ['Empty CSV — paste some data first.'] };
      const header = rawRows[0].map(s => s.toLowerCase());
      const required = ['name', 'photo_url'];
      const missing = required.filter(c => !header.includes(c));
      if (missing.length) return { rows: [], errors: [`CSV header is missing: ${missing.join(', ')}`] };

      const idx = {
        name:      header.indexOf('name'),
        photo_url: header.indexOf('photo_url'),
        status:    header.indexOf('status'),
      };

      const byName = {};
      A.PLAYERS.forEach(p => { byName[normPlayerName(p.name)] = p; });

      const out = [];
      for (let i = 1; i < rawRows.length; i++) {
        const r = rawRows[i];
        const get = k => idx[k] >= 0 ? (r[idx[k]] ?? '') : '';
        const name = get('name').trim();
        const photoUrl = get('photo_url').trim();
        const pipelineStatus = get('status').trim();

        const row = { line: i + 1, name, photoUrl, errors: [] };

        if (!name) row.errors.push('name is required');
        if (!photoUrl) row.errors.push('photo_url is required');
        if (pipelineStatus && !pipelineStatus.startsWith('ok')) {
          row.errors.push(`pipeline reported "${pipelineStatus}" for this row, not ok`);
        }

        const match = name ? byName[normPlayerName(name)] : null;
        if (!match) {
          row.matchState = 'unmatched';
          if (name) row.errors.push(`no player named "${name}" found — import their roster CSV row first`);
        } else {
          row.playerId = match.id;
          row.matchState = match.photoUrl ? 'update' : 'new';
        }

        out.push(row);
      }
      return { rows: out, errors: [] };
    }

    function renderPhotoCsvPreview(rows, errors) {
      const preview = $('#photoCsvPreview');
      const summary = $('#photoCsvSummary');
      const importBtn = $('#photoCsvImportBtn');
      if (errors.length) {
        preview.style.display = 'block';
        preview.innerHTML = `<table><tbody>${errors.map(e => `<tr class="row-err"><td>!</td><td class="err-msg">${escapeHtml(e)}</td></tr>`).join('')}</tbody></table>`;
        summary.textContent = '';
        importBtn.disabled = true; importBtn.textContent = 'Import';
        return;
      }

      const ok  = rows.filter(r => r.errors.length === 0);
      const bad = rows.filter(r => r.errors.length  >  0);
      const newCount    = ok.filter(r => r.matchState === 'new').length;
      const updateCount = ok.filter(r => r.matchState === 'update').length;

      const stateLabel = { new: 'New', update: 'Update', unmatched: 'Unmatched' };
      const rowsHtml = rows.map(r => {
        const status = r.errors.length ? '✗' : '✓';
        const cls    = r.errors.length ? 'row-err' : 'row-ok';
        const errs   = r.errors.length ? `<div class="err-msg">${escapeHtml(r.errors.join('; '))}</div>` : '';
        return `<tr class="${cls}">
          <td>${status}</td>
          <td>${escapeHtml(r.name)}${errs}</td>
          <td>${stateLabel[r.matchState] || ''}</td>
        </tr>`;
      }).join('');

      preview.style.display = 'block';
      preview.innerHTML = `
        <table>
          <thead><tr><th></th><th>Name</th><th>Status</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
      summary.textContent = `${newCount} new · ${updateCount} update · ${bad.length} unmatched/invalid · ${rows.length} total`;
      importBtn.disabled = ok.length === 0;
      importBtn.textContent = `Import ${ok.length} photo${ok.length===1?'':'s'}`;
      importBtn._rows = ok;
    }

    async function photoCsvPreviewHandler() {
      const text = $('#photoCsvText').value;
      if (!text.trim()) { toast('Paste the pipeline CSV output first.'); return; }
      const raw = parseCSV(text);
      const { rows, errors } = buildPhotoCsvRows(raw);
      renderPhotoCsvPreview(rows, errors);
    }

    async function photoCsvFileHandler(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      $('#photoCsvText').value = text;
      photoCsvPreviewHandler();
    }

    async function photoCsvImportHandler() {
      const rows = $('#photoCsvImportBtn')._rows;
      if (!rows || rows.length === 0) { toast('Nothing valid to import.'); return; }
      try {
        if (state.db) {
          const n = await state.db.bulkUpsertPlayerPhotos(
            rows.map(r => ({ id: r.playerId, photoUrl: r.photoUrl }))
          );
          A.PLAYERS = state.activeTournamentId
            ? await state.db.getPlayersForTournament(state.activeTournamentId)
            : await state.db.getPlayers();
          toast(`Imported ${n} photo${n===1?'':'s'}.`);
        } else {
          rows.forEach(r => {
            const idx = A.PLAYERS.findIndex(p => p.id === r.playerId);
            if (idx >= 0) A.PLAYERS[idx] = { ...A.PLAYERS[idx], photoUrl: r.photoUrl };
          });
          toast(`Imported ${rows.length} (local mode — not persisted).`);
        }
        closePhotoCsvView();
        renderAdmin(); renderPool(); render();
      } catch (e) { toast('Photo import failed: ' + e.message, 5000); }
    }


    // ─── RULES EDITOR ────────────────────────────────────────────────────────

    /**
     * Build the rule-grid HTML for a given format.
     * readOnly=true → plain text values (no inputs).
     */
    function buildRulesGrid(fmt, readOnly) {
      const cur = SCORING_RULES[fmt];
      const def = DEFAULT_SCORING_RULES[fmt];
      if (!cur) return '';
      const activeTournament = (state.tournaments || []).find(t => t.id === state.activeTournamentId);
      const dotBallEnabled   = !!activeTournament?.dot_ball_enabled;
      const grouped = {};
      Object.keys(cur).forEach(key => {
        // dot_ball is only shown in the editor once the tournament's
        // "Dot ball scoring" toggle is turned ON (migration_v30) — most feeds
        // don't reliably report a per-bowler dot-ball count, so this weight
        // is hidden by default rather than silently controlling a score the
        // admin can't see or edit.
        if (key === 'dot_ball' && !dotBallEnabled) return;
        const meta = RULE_META[key];
        if (!meta) return;
        (grouped[meta.group] ||= []).push(key);
      });
      // Minimum-sample-size gates: these bonuses/penalties only kick in once
      // the player has enough balls faced/bowled to make the rate meaningful.
      // Keep in sync with calcStrikeRateBonus/calcEconomyBonus in the scoring engine.
      const GROUP_THRESHOLD_NOTE = {
        'Strike rate': 'Only applied once the batter has faced ≥10 balls.',
        'Economy':     'Only applied once the bowler has bowled more than 6 balls (past the 1st over).',
      };
      return RULE_GROUP_ORDER.filter(g => grouped[g]?.length).map(group => {
        const rows = grouped[group].map(key => {
          const v = cur[key];
          const dv = def?.[key];
          const changed = dv !== undefined && Number(v) !== Number(dv);
          const cell = readOnly
            ? `<span class="rule-input ${changed ? 'changed' : ''}" style="display:inline-block;min-width:48px;text-align:right;padding:4px 6px;background:var(--panel);border-radius:4px;font-size:12px;">${v}</span>`
            : `<input type="number" step="0.5" class="rule-input ${changed ? 'changed' : ''}" data-key="${key}" value="${v}" />`;
          return `
            <label class="lbl" title="default: ${dv ?? '—'}">${RULE_META[key].label}</label>
            ${cell}
          `;
        }).join('');
        const note = GROUP_THRESHOLD_NOTE[group]
          ? `<div class="rule-group-note" style="font-size:11px; color:var(--muted); margin:-4px 0 6px;">${GROUP_THRESHOLD_NOTE[group]}</div>`
          : '';
        return `<div class="rule-group-title">${group}</div>${note}<div class="rule-grid">${rows}</div>`;
      }).join('');
    }

    /**
     * Tournament tab — scoring rules section.
     * Editable when tournament hasn't started; locked + read-only once it has.
     */
    function renderTournamentScoringRules() {
      const section = $('#tournamentScoringSection');
      if (!section) return;
      if (!state.activeTournamentId) { section.style.display = 'none'; return; }
      section.style.display = 'block';

      const nameEl = $('#tournamentScoringName');
      if (nameEl) {
        const activeTournament = (state.tournaments || []).find(t => t.id === state.activeTournamentId);
        nameEl.textContent = activeTournament?.name ? `Editing rules for: ${activeTournament.name}` : '';
      }

      const locked   = isTournamentStarted();
      const fmt      = state.rulesEditing || 'T20';
      const statusEl = $('#tournamentScoringStatus');
      const actions  = $('#tournamentScoringActions');
      const dirtyPill = $('#tournamentRulesDirty');

      statusEl.innerHTML = locked
        ? '<span style="color:var(--accent-2);">🔒 Locked — tournament in progress. Rules are final.</span>'
        : 'Customise points for each format before the first match starts.';

      if (actions) actions.style.display = locked ? 'none' : 'flex';
      if (dirtyPill) dirtyPill.classList.toggle('on', !locked && state.rulesDirty);

      // Sync format tab pills
      document.querySelectorAll('#tournamentRulesTabs .tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tfmt === fmt);
        t.style.pointerEvents = locked ? 'none' : '';
        t.style.opacity       = locked ? '0.7' : '';
      });

      const editor = $('#tournamentRulesEditor');
      if (!editor) return;
      editor.innerHTML = buildRulesGrid(fmt, locked);

      if (!locked) {
        editor.querySelectorAll('input.rule-input').forEach(inp => {
          inp.addEventListener('input', e => {
            const key = e.target.dataset.key;
            const num = parseFloat(e.target.value);
            if (Number.isFinite(num)) {
              SCORING_RULES[fmt][key] = num;
              state.rulesDirty = true;
              if (dirtyPill) dirtyPill.classList.add('on');
              const dv = DEFAULT_SCORING_RULES[fmt]?.[key];
              e.target.classList.toggle('changed', Number(num) !== Number(dv));
              render();
            }
          });
        });
      }
    }

    /**
     * Scoring tab — always read-only display of the current rules.
     */
    function renderRulesEditor() {
      const fmt = state.rulesEditing;
      $('#rulesFormatLabel').textContent = `(${fmt})`;
      document.querySelectorAll('.rules-tabs .tab').forEach(t => {
        t.classList.toggle('active', t.dataset.fmt === fmt);
      });
      // Update hint based on tournament state
      const hint = $('#scoringTabHint');
      if (hint) {
        hint.innerHTML = isTournamentStarted()
          ? '<span style="color:var(--accent-2);">🔒 Locked — tournament in progress</span>'
          : 'set rules in the <strong style="color:var(--accent); cursor:pointer;" id="scoringTabTournamentLink">Tournament tab</strong> before the first match';
      }
      const editor = $('#rulesEditor');
      editor.innerHTML = buildRulesGrid(fmt, /* readOnly */ true);
    }

    async function saveRules() {
      if (!state.db) { toast('Connect a database first to persist rules.'); return; }
      if (!state.activeTournamentId) { toast('No active tournament — create one first.'); return; }
      if (isTournamentStarted()) { toast('Rules are locked — tournament is already in progress.', 4000); return; }
      try {
        const fmt = state.rulesEditing;
        await state.db.saveScoringRules(state.activeTournamentId, fmt, SCORING_RULES[fmt]);
        state.rulesDirty = false;
        $('#tournamentRulesDirty')?.classList.remove('on');
        toast(`Saved ${fmt} scoring rules.`);
      } catch (e) { toast('Save failed: ' + e.message, 4000); }
    }

    async function resetRules() {
      if (isTournamentStarted()) { toast('Rules are locked — tournament is already in progress.', 4000); return; }
      const fmt = state.rulesEditing;
      if (!confirm(`Reset ${fmt} rules to the built-in defaults?`)) return;
      SCORING_RULES[fmt] = JSON.parse(JSON.stringify(DEFAULT_SCORING_RULES[fmt]));
      state.rulesDirty = false;
      if (state.db && state.activeTournamentId) {
        try { await state.db.resetScoringRules(state.activeTournamentId, fmt); }
        catch (e) { toast('DB reset failed: ' + e.message); }
      }
      renderTournamentScoringRules(); renderRulesEditor(); render();
      toast(`${fmt} rules reset to defaults.`);
    }

    /**
     * Snapshot the currently-effective rules (built-in defaults merged with
     * whatever this tournament has saved) into the tournament's own locked
     * scoring_rules, for every format. After this, changing the app's
     * DEFAULT_SCORING_RULES (e.g. adding a new bonus tier) can no longer
     * retroactively change this tournament's scoring — every key the engine
     * knows about is now explicitly pinned on the tournament itself.
     *
     * Use this on any tournament that's already in progress or completed,
     * right before shipping a scoring-rule change, so the change only
     * applies going forward. (This is exactly what the manual SQL patch for
     * Major League Cricket did by hand — this is the one-click version.)
     */
    async function freezeTournamentRules() {
      if (!state.db) { toast('Connect a database first.'); return; }
      if (!state.activeTournamentId) { toast('No active tournament — select one first.'); return; }
      const t = (state.tournaments || []).find(x => x.id === state.activeTournamentId);
      const name = t?.name || 'this tournament';
      if (!confirm(
        `Freeze scoring rules for "${name}"?\n\n`
        + `This writes the currently-effective rules (built-in defaults + any saved overrides) `
        + `into this tournament's locked rules for every format. Future changes to the app's `
        + `default scoring rules will no longer affect "${name}" unless you edit its rules again.`
      )) return;

      const btn = $('#tournamentFreezeRulesBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Freezing…'; }
      try {
        for (const fmt of ['T20', 'ODI', 'TEST']) {
          const frozen = { ...DEFAULT_SCORING_RULES[fmt], ...(SCORING_RULES[fmt] || {}) };
          await state.db.saveScoringRules(state.activeTournamentId, fmt, frozen);
        }
        toast(`Froze scoring rules for "${name}" — future default changes won't retroactively affect it.`);
      } catch (e) {
        toast('Freeze failed: ' + e.message, 5000);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧊 Freeze rules'; }
      }
    }

    // ─── Score Audit ─────────────────────────────────────────────────────────

    let lastAuditResults = null; // cache so Recalc/Finalize buttons can re-render without a full re-fetch of stale data
    let lastAuditRawStats = null; // { stats, playerById, tFmt } — kept so "Fix" can recompute from already-stored batting/bowling/fielding without hitting CricAPI

    /**
     * Recomputes every player_match_stats row in the active tournament from
     * its saved batting/bowling/fielding stats + the tournament's locked
     * scoring_rules (same merge as buildRulesGrid/saveRules use), and flags
     * any row whose stored raw_points doesn't match. Also flags completed
     * matches with zero player_match_stats rows at all.
     *
     * Uses the exact same calculateScore() the rest of the app scores
     * matches with — not a reimplementation — so a flagged mismatch always
     * means real drift between stored data and current rules/stats, never a
     * difference in scoring logic itself.
     */
    async function runScoreAudit() {
      if (!state.db) { toast('Connect a database first.'); return; }
      if (!state.activeTournamentId) { toast('No active tournament — select one first.'); return; }

      const btn = $('#scoreAuditBtn');
      const statusEl = $('#scoreAuditStatus');
      const resultsEl = $('#scoreAuditResults');
      if (btn) { btn.disabled = true; btn.textContent = 'Auditing…'; }
      if (resultsEl) resultsEl.style.display = 'none';

      try {
        const t = (state.tournaments || []).find(x => x.id === state.activeTournamentId);
        const tFmt = (t?.format || 'T20').toUpperCase();
        const { matches, stats, players } = await state.db.getAuditDataForTournament(state.activeTournamentId);

        if (!matches.length) {
          statusEl.textContent = 'No matches in this tournament yet.';
          lastAuditResults = null;
          return;
        }

        const matchById  = new Map(matches.map(m => [m.id, m]));
        const playerById2 = new Map(players.map(p => [p.id, p]));

        const missingScorecard = matches.filter(m =>
          m.status === 'completed' && !stats.some(s => s.match_id === m.id));

        const TOLERANCE = 0.05;
        const mismatches = [];
        for (const row of stats) {
          const match = matchById.get(row.match_id);
          const fmt = (match?.format || tFmt || 'T20').toUpperCase();
          const player = playerById2.get(row.player_id);
          const role = player?.role ?? 'bat';
          const rules = { ...DEFAULT_SCORING_RULES[fmt], ...((t?.scoring_rules || {})[fmt] || {}) };

          const scored = calculateScore(
            { name: player?.name ?? row.player_id, role, captaincy: 'normal',
              batting: row.batting, bowling: row.bowling, fielding: row.fielding },
            fmt, rules,
          );
          const recomputed = scored.rawPoints;
          const stored = Number(row.raw_points ?? 0);

          if (Math.abs(recomputed - stored) > TOLERANCE) {
            mismatches.push({
              matchId: row.match_id, matchNumber: match?.match_number ?? '?',
              playerId: row.player_id, playerName: player?.name ?? row.player_id,
              stored, recomputed, diff: Math.round((recomputed - stored) * 10) / 10,
            });
          }
        }

        // Kept for recomputeStoredStatsForMatch — lets "Fix" re-derive
        // raw_points from the batting/bowling/fielding already sitting in
        // player_match_stats (unchanged) instead of refetching from CricAPI,
        // which the scraper-sourced tournaments have no reliable link to.
        lastAuditRawStats = { stats, playerById: playerById2, matchById, tFmt, tournamentScoringRules: t?.scoring_rules || {} };

        lastAuditResults = { missingScorecard, mismatches, rowsChecked: stats.length, matchCount: matches.length };
        renderScoreAuditResults();

        statusEl.textContent = `Checked ${stats.length} player-match row(s) across ${matches.length} match(es) — `
          + `${mismatches.length} mismatch(es), ${missingScorecard.length} match(es) missing stats.`;
      } catch (e) {
        statusEl.textContent = 'Audit failed: ' + e.message;
        toast('Audit failed: ' + e.message, 5000);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Run Score Audit'; }
      }
    }

    /**
     * Recomputes and re-saves raw_points for every player_match_stats row of
     * one match using the stats ALREADY STORED (batting/bowling/fielding
     * left untouched) — no CricAPI call. This is the right fix for the
     * "bowler wrongly got duck penalty" class of bug: the captured stats
     * were always correct, only the role used to score them was wrong, so
     * there's nothing to refetch. Use the row's "Finalize" (or Score Audit's
     * "Re-finalize", same underlying function — see finalizeOneMatch) instead
     * only when the stored stats themselves are missing or wrong (e.g. a
     * genuinely incomplete scorecard) — for scraper-sourced tournaments that
     * path also isn't reliable yet since matches usually have no real CricAPI
     * external_id to refetch from (see docs/score_audit_track_streamline_plan.md §3.5).
     */
    async function recomputeStoredStatsForMatch(matchId) {
      if (!state.db) { toast('Connect a database first.'); return; }
      if (!lastAuditRawStats) { toast('Run Score Audit first.'); return; }

      const { stats, playerById, matchById, tFmt, tournamentScoringRules } = lastAuditRawStats;
      const match = matchById.get(matchId);
      const fmt = (match?.format || tFmt || 'T20').toUpperCase();
      const rules = { ...DEFAULT_SCORING_RULES[fmt], ...(tournamentScoringRules[fmt] || {}) };

      const rowsForMatch = stats.filter(s => s.match_id === matchId);
      if (!rowsForMatch.length) { toast('No stored stats for this match.'); return; }

      const rows = rowsForMatch.map(row => {
        const player = playerById.get(row.player_id);
        const role = player?.role ?? 'bat';
        const scored = calculateScore(
          { name: player?.name ?? row.player_id, role, captaincy: 'normal',
            batting: row.batting, bowling: row.bowling, fielding: row.fielding },
          fmt, rules,
        );
        return {
          playerId : row.player_id,
          batting  : row.batting  ?? null,
          bowling  : row.bowling  ?? null,
          fielding : row.fielding ?? null,
          rawPoints: scored.rawPoints,
        };
      });

      const n = await state.db.bulkUpsertPlayerMatchStats(matchId, rows);
      const xiSaved = await computeAndSaveXIScoresForMatch(matchId);
      await computeAndSaveSLScoresForMatch(matchId);

      toast(`Fixed M${match?.match_number ?? '?'} — ${n} row(s) recomputed from stored stats (no CricAPI call)`
        + `${xiSaved ? `, ${xiSaved} XI total${xiSaved === 1 ? '' : 's'} updated` : ''}.`);
      renderMatchesAdmin();
      renderHistory();
      if ($('#lbModal')?.classList.contains('open')) {
        await renderLeaderboard();
        maybeStartLbPolling();
      }
    }

    function renderScoreAuditResults() {
      const resultsEl = $('#scoreAuditResults');
      if (!resultsEl) return;
      if (!lastAuditResults) { resultsEl.style.display = 'none'; return; }
      const { missingScorecard, mismatches } = lastAuditResults;

      if (!missingScorecard.length && !mismatches.length) {
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = `<div style="color:var(--good); font-size:12px;">✓ Every player-match row matches its recomputed points.</div>`;
        return;
      }

      const rows = [];
      for (const m of missingScorecard) {
        rows.push(`
          <tr>
            <td>M${m.match_number}</td>
            <td colspan="3" style="color:var(--bad);">Completed match — no player_match_stats at all</td>
            <td><button class="row-audit-finalize" data-match-id="${m.id}" style="font-size:11px; padding:3px 8px;" title="Fetch this match's scorecard — from CricAPI or the scraper, whichever this match is tracked on — &amp; save fantasy points">Finalize</button></td>
          </tr>`);
      }
      for (const m of mismatches) {
        rows.push(`
          <tr>
            <td>M${m.matchNumber}</td>
            <td>${escapeHtml(m.playerName)}</td>
            <td>${m.stored}</td>
            <td>${m.recomputed} <span style="color:${m.diff > 0 ? 'var(--accent-2)' : 'var(--bad)'};">(${m.diff > 0 ? '+' : ''}${m.diff})</span></td>
            <td>
              <button class="row-audit-fix" data-match-id="${m.matchId}" style="font-size:11px; padding:3px 8px;" title="Recompute from already-stored stats — no CricAPI call">Fix</button>
              <button class="row-audit-refinalize" data-match-id="${m.matchId}" style="font-size:11px; padding:3px 8px;" title="Re-finalize — refetch from this match's source (CricAPI, reusing a finished-looking cache when possible; or the scraper) &amp; re-save. Use when the stored stats themselves are wrong/incomplete.">Re-finalize</button>
            </td>
          </tr>`);
      }

      resultsEl.style.display = 'block';
      resultsEl.innerHTML = `
        <table class="admin-table" style="width:100%; font-size:12px;">
          <thead><tr><th>Match</th><th>Player</th><th>Stored</th><th>Recomputed</th><th></th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>`;

      resultsEl.querySelectorAll('.row-audit-fix').forEach(b => {
        b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = '…';
          try {
            await recomputeStoredStatsForMatch(b.dataset.matchId);
          } catch (e) {
            toast('Fix failed: ' + e.message, 5000);
          }
          await runScoreAudit(); // re-check so fixed rows drop off the list
        });
      });
      resultsEl.querySelectorAll('.row-audit-refinalize').forEach(b => {
        b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = '…';
          // Recalc used to call forceRefinalizeMatch directly — that function
          // is gone (merged into finalizeOneMatch, see §3.2 of the plan doc).
          // Routed through finalizeMatchRouted (not finalizeMatchById
          // directly) so a scraper-tracked mismatch row re-scrapes instead of
          // wrongly attempting a CricAPI fetch — see §3.2/§3.5.
          await finalizeMatchRouted(b.dataset.matchId);
          await runScoreAudit(); // re-check so fixed rows drop off the list
        });
      });
      resultsEl.querySelectorAll('.row-audit-finalize').forEach(b => {
        b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = '…';
          // Routed (not finalizeMatchById directly) for the same reason as
          // Re-finalize above — a scraper-tracked match with a completely
          // missing scorecard usually has no external_id, which would make
          // finalizeMatchById's own lookup misreport it as "already
          // finalized" instead of actually scraping it. See §3.5.
          await finalizeMatchRouted(b.dataset.matchId);
          await runScoreAudit();
        });
      });
    }


  // ─── REGISTER ADMIN API ──────────────────────────────────────────────────
  /**
   * Refresh admin views after a DB connect or after admin.js first loads.
   * Only re-renders the currently active tab so the user's tournament
   * selection is preserved (don't eagerly render all tabs).
   * Called from connectDb() in index.html (via guard) and from loadAdminModule().then().
   */
  function refreshAdminViews() {
    renderApiPill();
    if (!state.db) return;
    // Re-render the current tab (or default to 'players' if none selected yet)
    setAdminTab(state.adminTab || 'players');
  }

  // Functions needed from index.html are accessed via window.__admin?.fn?.()
  window.__admin = {
    openAdmin,
    closeAdmin,
    setAdminTab,
    renderAdmin,
    renderMatchesAdmin,
    renderContestsAdmin,
    renderTeamsAdmin,
    renderRulesEditor,
    renderTournamentScoringRules,
    renderFantasyScorecard,
    saveFantasyScorecard,
    rescoreCurrentMatch,
    nextPlayerId,
    computeAndSaveXIScoresForMatch,
    computeAndSaveSLScoresForMatch,
    incrementApiCallCount,
    renderApiPill,
    getApiKeys,
    setActiveApiKey,
    renderLiveMatchTrackControls,
    renderLiveTournamentBar,
    isKeyExhaustedError,
    get CRIC_TEAM_CODE_MAP() { return CRIC_TEAM_CODE_MAP; },
    syncMatchesFromCricAPI,
    finalizeCompletedMatches,
    saveRules,
    resetRules,
    freezeTournamentRules,
    runScoreAudit,
    openCsvView,
    closeCsvView,
    csvPreviewHandler,
    csvFileHandler,
    csvImportHandler,
    downloadCSVTemplate,
    openPhotoCsvView,
    closePhotoCsvView,
    photoCsvPreviewHandler,
    photoCsvFileHandler,
    photoCsvImportHandler,
    openMatchesCsvView,
    closeMatchesCsvView,
    matchesCsvPreviewHandler,
    matchesCsvFileHandler,
    matchesCsvImportHandler,
    downloadMatchesCSVTemplate,
    forcePollNow: A.forcePollNow,
    refreshAdminViews,
  };

})();
