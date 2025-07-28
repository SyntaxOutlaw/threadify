import app from 'flarum/admin/app';

console.log('[Threadify] Admin panel JS loaded');

app.initializers.add('syntaxoutlaw-threadify-admin', () => {
  app.extensionData
    .for('syntaxoutlaw-threadify')
    .registerSetting(function () {
      return m('div', [
        m('button', {
          className: 'Button Button--danger',
          onclick: () => {
            if (!confirm('Are you sure? This will rebuild parent_id and threadify_threads from scratch!')) return;
            this.loading = true;
            m.redraw();
            app.request({
              method: 'POST',
              url: app.forum.attribute('apiUrl') + '/threadify/admin/rebuild-parent-ids',
            }).then(result => {
              alert('Rebuild complete!\n' + JSON.stringify(result.results, null, 2));
              this.loading = false;
              m.redraw();
            }).catch(e => {
              alert('Error: ' + (e.message || e));
              this.loading = false;
              m.redraw();
            });
          },
          disabled: this.loading
        }, this.loading ? 'Rebuilding...' : 'Danger: Rebuild parent_id and threads')
      ]);
    });
});
