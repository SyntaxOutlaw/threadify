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
  const apiUrl = () => app.forum.attribute('apiUrl');

  const TAGS_SETTING = 'syntaxoutlaw-threadify.tags';

  // Multi-select dropdown with search (react-select style)
  const MultiSelectDropdown = {
    oninit() {
      this.open = false;
      this.searchQuery = '';
      this.dom = null;
      this.clickOutside = (e) => {
        if (this.open && this.dom && !this.dom.contains(e.target)) {
          this.open = false;
          this.searchQuery = '';
          m.redraw();
        }
      };
    },
    oncreate(vnode) {
      this.dom = vnode.dom;
      document.addEventListener('click', this.clickOutside);
    },
    onupdate(vnode) {
      this.dom = vnode.dom;
    },
    onremove() {
      document.removeEventListener('click', this.clickOutside);
    },
    view(vnode) {
      const { options, selected, onToggle, placeholder, disabled, disabledMessage, getLabel } = vnode.attrs;
      const query = (this.searchQuery || '').toLowerCase().trim();
      const filtered = query
        ? options.filter(opt => getLabel(opt).toLowerCase().includes(query))
        : options;

      const triggerLabel = selected.length === 0
        ? (placeholder || 'Select…')
        : selected.length === 1
          ? getLabel(options.find(o => (o.attributes?.slug || o.attributes?.name || '') === selected[0]) || { attributes: { name: selected[0] } })
          : `${selected.length} tag(s) selected`;

      const handleClick = (e) => {
        e.stopPropagation();
        if (disabled) {
          if (disabledMessage) {
            app.alerts.show({ type: 'info' }, disabledMessage);
          }
          return;
        }
        this.open = !this.open;
        m.redraw();
      };

      return m('div', {
        className: 'ThreadifyMultiSelect',
        style: { position: 'relative', marginTop: '0.25rem' }
      }, [
        m('button', {
          type: 'button',
          className: 'FormControl',
          style: { textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: disabled ? 0.6 : 1 },
          onclick: handleClick
        }, [
          m('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, triggerLabel),
          m('span', { style: { marginLeft: '0.5rem', flexShrink: 0 } }, this.open ? ' ▲' : ' ▼')
        ]),
        this.open && !disabled && m('div', {
          className: 'Dropdown-menu',
          style: {
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '2px',
            zIndex: 1000,
            background: 'var(--body-bg, #fff)',
            border: '1px solid var(--border-color, #ddd)',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            maxHeight: '280px',
            display: 'flex',
            flexDirection: 'column'
          }
        }, [
          m('div', { style: { padding: '6px', borderBottom: '1px solid var(--border-color, #eee)' } }, [
            m('input', {
              type: 'text',
              className: 'FormControl',
              placeholder: 'Search tags…',
              value: this.searchQuery,
              oninput: (e) => { this.searchQuery = e.target.value; m.redraw(); },
              onkeydown: (e) => { e.stopPropagation(); },
              style: { margin: 0 }
            })
          ]),
          m('div', {
            style: { overflowY: 'auto', maxHeight: '220px', padding: '4px 0' }
          }, filtered.length === 0
            ? m('div', { style: { padding: '8px 12px', color: 'var(--muted-color, #999)' } }, 'No tags match')
            : filtered.map(opt => {
                const slug = opt.attributes?.slug || opt.attributes?.name || '';
                const name = getLabel(opt);
                const checked = selected.includes(slug);
                return m('div', {
                  role: 'button',
                  tabindex: 0,
                  className: 'Dropdown-item',
                  style: {
                    cursor: 'pointer',
                    padding: '6px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: checked ? 'var(--primary-color, #4d698e)' : 'transparent',
                    color: checked ? '#fff' : 'inherit'
                  },
                  onclick: (e) => { e.preventDefault(); e.stopPropagation(); onToggle(slug, checked); },
                  onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(slug, checked); } }
                }, [
                  m('span', { style: { flexShrink: 0, width: '16px', textAlign: 'center' } }, checked ? '✓' : ''),
                  m('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, name)
                ]);
              })
          )
        ])
      ]);
    }
  };

  // Load our settings first (includes tagsExtensionEnabled). Only call /tags when Tags extension is enabled.
  const TagSelectorSetting = {
    oninit(vnode) {
      this.tags = [];
      this.selectedTags = []; // array of slugs
      this.loading = true;
      this.tagsExtensionEnabled = false;

      app.request({ method: 'GET', url: apiUrl() + '/threadify/admin/settings' })
        .then((settingsResponse) => {
          const body = settingsResponse && (settingsResponse.threadifyTag !== undefined ? settingsResponse : (settingsResponse.data || {}));
          this.selectedTags = Array.isArray(body && body.threadifyTags) ? body.threadifyTags : (body && body.threadifyTag ? [body.threadifyTag] : ['threadify']);
          this.tagsExtensionEnabled = !!(body && body.tagsExtensionEnabled);
          if (!app.data.settings) app.data.settings = {};
          app.data.settings[TAGS_SETTING] = JSON.stringify(this.selectedTags);

          if (!this.tagsExtensionEnabled) {
            this.loading = false;
            m.redraw();
            return;
          }
          return app.request({ method: 'GET', url: apiUrl() + '/tags' });
        })
        .then((tagsResponse) => {
          if (tagsResponse && tagsResponse.data) this.tags = tagsResponse.data;
          this.loading = false;
          m.redraw();
        })
        .catch(() => {
          this.loading = false;
          m.redraw();
        });
    },

    view(vnode) {
      const isTagMode = vnode.attrs.isTagMode || false;

      if (!this.tagsExtensionEnabled) {
        return m('div', { className: 'Form-group' }, [
          m('p', { className: 'helpText', style: { color: 'var(--muted-color, #999)' } }, 'Tag-based threading is not available. Enable the Tags extension (flarum/tags) to choose threadify tags.')
        ]);
      }

      const selectedTags = Array.isArray(this.selectedTags) ? this.selectedTags : [];

      const saveTags = (newSelected) => {
        this.selectedTags = newSelected;
        const value = JSON.stringify(newSelected);
        if (!app.data.settings) app.data.settings = {};
        app.data.settings[TAGS_SETTING] = value;
        app.request({
          method: 'POST',
          url: apiUrl() + '/settings',
          body: { [TAGS_SETTING]: value }
        }).then(() => {
          app.alerts.show({ type: 'success' }, 'Your settings have been saved.');
          m.redraw();
        }).catch((e) => { console.error('[Threadify] Failed to save tag setting', e); });
        m.redraw();
      };

      const onToggle = (slug, currentlySelected) => {
        const next = currentlySelected ? selectedTags.filter(s => s !== slug) : selectedTags.concat(slug);
        saveTags(next);
      };

      return m('div', { className: 'Form-group' }, [
        m('label', {}, 'Threadify tag(s)'),
        m(MultiSelectDropdown, {
          options: this.tags,
          selected: selectedTags,
          onToggle,
          placeholder: 'Select tag(s)…',
          disabled: !isTagMode || this.loading,
          disabledMessage: 'This setting only applies when "Thread discussions by tag" mode is enabled.',
          getLabel: (opt) => (opt.attributes && (opt.attributes.name || opt.attributes.slug)) || ''
        }),
        m('p', { className: 'helpText', style: { marginTop: '0.5rem' } }, 'Select which tag(s) enable threading for discussions. Discussions with any selected tag will be threaded.')
      ]);
    }
  };

  // When Tags is disabled we show only "Thread all" and a note; when enabled we show mode + tag dropdown.
  const ThreadifyModeAndTagSettings = {
    oninit() {
      this.settingsLoaded = false;
      this.tagsExtensionEnabled = false;
      app.request({ method: 'GET', url: apiUrl() + '/threadify/admin/settings' })
        .then((res) => {
          const body = res && (res.threadifyTag !== undefined ? res : (res.data || {}));
          this.tagsExtensionEnabled = !!(body && body.tagsExtensionEnabled);
          this.settingsLoaded = true;
          m.redraw();
        })
        .catch(() => { this.settingsLoaded = true; m.redraw(); });
    },
    view() {
      if (!this.settingsLoaded) return m('div', { className: 'Form-group' }, m('p', { className: 'helpText' }, 'Loading…'));

      // Tags disabled: assume "Thread all", keep Threadify tag heading, no dropdown, message on separate line
      if (!this.tagsExtensionEnabled) {
        return m('div', [
          m('div', { className: 'Form-group' }, [
            m('label', {}, 'Threadify mode'),
            m('p', { className: 'helpText', style: { marginTop: '0.25rem' } }, 'Thread all discussions.')
          ]),
          m('div', { className: 'Form-group' }, [
            m('label', {}, 'Threadify tag'),
            m('p', { className: 'helpText', style: { marginTop: '0.25rem' } }, 'Enable the Tags extension (flarum/tags) to use tag-based threading.')
          ])
        ]);
      }

      // Tags enabled: show mode dropdown and tag dropdown
      const mode = app.data.settings['syntaxoutlaw-threadify.mode'] || 'default';
      const isTagMode = mode === 'tag';
      return m('div', [
        m('div', { className: 'Form-group' }, [
          m('label', {}, 'Threadify mode'),
          m('select', {
            className: 'FormControl',
            value: mode,
            onchange: (e) => {
              const v = e.target.value;
              if (!app.data.settings) app.data.settings = {};
              app.data.settings['syntaxoutlaw-threadify.mode'] = v;
              app.request({
                method: 'POST',
                url: apiUrl() + '/settings',
                body: { 'syntaxoutlaw-threadify.mode': v }
              }).then(() => {
                app.alerts.show({ type: 'success' }, 'Your settings have been saved.');
                m.redraw();
              }).catch(() => {});
              m.redraw();
            }
          }, [
            m('option', { value: 'default' }, 'Thread all discussions'),
            m('option', { value: 'tag' }, 'Thread discussions by tag')
          ])
        ]),
        m('div', { className: 'Form-group' }, [
          m(TagSelectorSetting, { isTagMode })
        ])
      ]);
    }
  };

  app.extensionData
    .for('syntaxoutlaw-threadify')
    // Mode + tag settings: when Tags disabled, show only "Thread all" and a note; when enabled, show mode select + tag select
    .registerSetting(function() {
      return m(ThreadifyModeAndTagSettings);
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
