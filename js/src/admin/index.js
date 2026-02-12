import app from 'flarum/admin/app';
import Modal from 'flarum/common/components/Modal';
import Button from 'flarum/common/components/Button';

console.log('[Threadify] Admin panel JS loaded');

// Confirmation modal for rebuild action
class RebuildConfirmModal extends Modal {
  oninit(vnode) {
    super.oninit(vnode);
    this.loading = false;
    this.result = null;
    this.error = null;
  }

  className() {
    return 'RebuildConfirmModal Modal--small';
  }

  title() {
    if (this.result) {
      return 'Rebuild Complete';
    }
    if (this.error) {
      return 'Rebuild Failed';
    }
    return 'Rebuild Threadify Database Tables';
  }

  content() {
    // Show success results
    if (this.result) {
      const results = this.result.results || {};
      return [
        m('div', { className: 'Modal-body' }, [
          m('div', { className: 'Form-group' }, [
            m('p', { style: { marginBottom: '1rem', color: 'var(--success-color, #4caf50)' } }, [
              m('strong', '✅ Rebuild completed successfully!')
            ]),
            m('div', { style: { fontSize: '0.9em', color: 'var(--muted-color, #999)', marginBottom: '1rem' } }, [
              m('p', { style: { margin: '0.25rem 0' } }, `Threads processed: ${results.threads_processed || 0}`),
              m('p', { style: { margin: '0.25rem 0' } }, `Threads cleared: ${results.threads_cleared || 0}`),
              m('p', { style: { margin: '0.25rem 0' } }, `Errors: ${results.threads_errors || 0}`),
              results.parent_id_updated !== undefined && m('p', { style: { margin: '0.25rem 0' } }, `Parent IDs updated: ${results.parent_id_updated || 0}`),
            ])
          ])
        ]),
        m('div', { className: 'Modal-footer' }, [
          Button.component({
            className: 'Button Button--primary',
            onclick: () => this.hide()
          }, 'Close')
        ])
      ];
    }

    // Show error
    if (this.error) {
      return [
        m('div', { className: 'Modal-body' }, [
          m('div', { className: 'Form-group' }, [
            m('p', { style: { marginBottom: '1rem', color: 'var(--alert-color, #f44336)' } }, [
              m('strong', '❌ Rebuild failed:')
            ]),
            m('p', { style: { color: 'var(--text-color, #333)' } }, this.error)
          ])
        ]),
        m('div', { className: 'Modal-footer' }, [
          Button.component({
            className: 'Button Button--primary',
            onclick: () => {
              this.error = null;
              this.loading = false;
              m.redraw();
            }
          }, 'Try Again'),
          Button.component({
            className: 'Button',
            onclick: () => this.hide()
          }, 'Close')
        ])
      ];
    }

    // Show confirmation
    return [
      m('div', { className: 'Modal-body' }, [
        m('div', { className: 'Form-group' }, [
          m('p', { style: { marginBottom: '1rem' } }, [
            m('strong', '⚠️ DANGER: '),
            'This action will rebuild the parent_id and threadify_threads tables from scratch.'
          ]),
          m('p', { style: { marginBottom: '1rem', color: 'var(--muted-color, #999)' } }, [
            'This process may take a while on large forums. All existing thread relationships will be recalculated based on post mentions.'
          ]),
          m('p', { style: { marginBottom: '0', fontWeight: 'bold' } }, [
            'Are you sure you want to continue?'
          ])
        ])
      ]),
      m('div', { className: 'Modal-footer' }, [
        Button.component({
          className: 'Button Button--primary',
          loading: this.loading,
          onclick: () => {
            this.loading = true;
            app.request({
              method: 'POST',
              url: app.forum.attribute('apiUrl') + '/threadify/admin/rebuild-parent-ids',
            }).then(result => {
              // Show detailed results in console for debugging
              console.log('Rebuild complete:', result.results);
              this.result = result;
              this.loading = false;
              m.redraw();
            }).catch(e => {
              this.error = e.message || e;
              this.loading = false;
              m.redraw();
            });
          }
        }, 'Yes, Rebuild Now'),
        Button.component({
          className: 'Button',
          onclick: () => this.hide()
        }, 'Cancel')
      ])
    ];
  }
}

app.initializers.add('syntaxoutlaw-threadify-admin', () => {
  // Custom tag selector component: dropdown only, loads current value from API, saves on change
  const TagSelectorSetting = {
    oninit(vnode) {
      this.tags = [];
      this.currentValue = ''; // loaded from API so dropdown shows correct value after reload
      this.loading = true;
      this.savedMessage = false; // show "saved" feedback after changing tag

      const apiUrl = app.forum.attribute('apiUrl');

      // Load tags and current threadify tag in parallel
      Promise.all([
        app.request({ method: 'GET', url: apiUrl + '/tags' }),
        app.request({ method: 'GET', url: apiUrl + '/threadify/admin/settings' })
      ]).then(([tagsResponse, settingsResponse]) => {
        this.tags = tagsResponse.data || [];
        // Flarum may return parsed body directly or under .data
        const body = settingsResponse && (settingsResponse.threadifyTag !== undefined ? settingsResponse : settingsResponse.data);
        this.currentValue = (body && body.threadifyTag) || '';
        if (!app.data.settings) app.data.settings = {};
        app.data.settings['syntaxoutlaw-threadify.tag'] = this.currentValue;
        this.loading = false;
        m.redraw();
      }).catch(() => {
        this.loading = false;
        m.redraw();
      });
    },

    view(vnode) {
      const setting = vnode.attrs.setting;
      // Use component state (loaded from API) so dropdown shows correct value after reload
      const currentValue = this.currentValue !== undefined
        ? this.currentValue
        : (app.data && app.data.settings && app.data.settings[setting]) || '';

      return m('div', { className: 'Form-group' }, [
        m('label', {}, 'Threadify tag'),
        m('select', {
          className: 'FormControl',
          value: currentValue,
          onchange: (e) => {
            const newValue = e.target.value;
            this.currentValue = newValue;
            if (!app.data.settings) app.data.settings = {};
            app.data.settings[setting] = newValue;
            this.savedMessage = false;

            app.request({
              method: 'POST',
              url: app.forum.attribute('apiUrl') + '/settings',
              body: { [setting]: newValue }
            }).then(() => {
              this.savedMessage = true;
              m.redraw();
              setTimeout(() => {
                this.savedMessage = false;
                m.redraw();
              }, 3000);
            }).catch((e) => {
              console.error('[Threadify] Failed to save tag setting', e);
            });

            m.redraw();
          },
          disabled: this.loading
        }, [
          m('option', { value: '', selected: currentValue === '' }, '-- Select a tag --'),
          ...this.tags.map(tag => {
            const slug = tag.attributes?.slug || tag.attributes?.name || '';
            const name = tag.attributes?.name || slug;
            return m('option', { value: slug, selected: currentValue === slug }, name);
          })
        ]),
        this.savedMessage && m('p', {
          className: 'helpText',
          style: { color: 'var(--success-color, #4caf50)', marginTop: '0.5rem', fontWeight: '500' }
        }, 'Your settings have been saved.'),
        m('p', { className: 'helpText' }, 'Select which tag should enable threading for discussions. Only discussions with this tag will be threaded when "Thread by tag" mode is enabled.')
      ]);
    }
  };

  app.extensionData
    .for('syntaxoutlaw-threadify')
    // Threading mode setting: thread all discussions by default, or only those with a selected tag
    .registerSetting({
      setting: 'syntaxoutlaw-threadify.mode',
      type: 'select',
      label: 'Threadify mode',
      options: {
        default: 'Thread all discussions',
        tag: 'Thread discussions with selected tag',
      },
      default: 'default',
    })
    // Tag selector: dropdown only. Value loaded from GET /threadify/admin/settings, saved via POST /settings.
    .registerSetting(function() {
      const mode = app.data.settings['syntaxoutlaw-threadify.mode'] || 'default';
      const isTagMode = mode === 'tag';

      return m('div', [
        m(TagSelectorSetting, {
          setting: 'syntaxoutlaw-threadify.tag'
        }),
        !isTagMode && m('p', {
          className: 'helpText',
          style: { color: 'var(--muted-color, #999)', fontStyle: 'italic', marginTop: '0.5rem' }
        }, 'Note: This setting only applies when "Thread discussions with selected tag" mode is enabled.')
      ]);
    })
    // Existing dangerous rebuild action
    .registerSetting(function () {
      return m('div', {
        style: {
          marginTop: '2rem',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border-color, #ddd)',
          marginBottom: '2rem',
          paddingBottom: '1.5rem',
          borderBottom: '1px solid var(--border-color, #ddd)',
        }
      }, [
        m('button', {
          className: 'Button Button--danger',
          onclick: () => {
            app.modal.show(RebuildConfirmModal);
          },
          disabled: this.loading
        }, this.loading ? 'Rebuilding...' : 'Rebuild Threadify Database Tables')
      ]);
    });
});
