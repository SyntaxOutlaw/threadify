# Threadify for Flarum

A Flarum extension that adds **threaded discussions** with visual indentation to your forum, making complex conversations easier to follow.

## 🚀 Features

- **Multi-level nested threading** with distinct colors and indentation for each depth
- **Smart post loading** - automatically loads missing parent/child posts for complete threading
- **Real-time updates** - new replies appear in correct threaded positions instantly
- **Mobile-optimized** responsive design with compact spacing
- **Seamless integration** - uses existing Flarum mentions, no new UI needed

## 📋 Requirements

- **Flarum** v1.8.10+ (tested on 1.8.10)
- **Flarum Mentions Extension** - Required for threading to work
- **PHP** 7.4+

## 👀 Preview:
![Threadify Preview](threadify.png)




## 🔧 Installation

### Via Composer (when published)
```bash
composer require syntaxoutlaw/threadify
```

### Manual Installation
1. Clone/download this repository into your `extensions/threadify/` directory
2. Run `composer install` in the extension directory
3. Run `cd js && npm install && npm run build` to compile JavaScript
4. Enable the extension in your Flarum admin panel

## 🎯 How to Use

Threading works automatically using Flarum's mentions extension:

1. **Click Reply** on any post
2. **Keep the @ mention** that's automatically inserted (e.g., `@"Username"#p123`)
3. **Write your reply** and submit
4. Your reply will appear **indented** under the parent post

## ⚙️ How It Works

**Backend (PHP)**
- Adds a `parent_id` column to posts table via migration
- Listens for new posts and extracts parent relationships from mention format `@"Name"#p123`

**Frontend (JavaScript)**  
- Intercepts the PostStream to reorder posts into threaded hierarchy
- Builds parent-child tree structures and flattens them back to linear threaded order
- Surgically loads missing parent/child posts with targeted API calls for complete threading
- Applies CSS classes for visual depth styling

**Visual Styling**
- Each thread depth gets unique color (blue → green → orange → red → purple...)
- Progressive indentation
- Subtle background colors for threaded posts



## 🔍 Troubleshooting

- **Threading not working?** Ensure `flarum/mentions` extension is enabled
- **Posts not loading?** Check browser console for errors and run `php flarum cache:clear`
- **Visual issues?** Run `php flarum assets:publish` and clear browser cache

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Dependencies

- **Flarum Mentions Extension** - Provides the `@"username"#p123` format that enables threading
- **Flarum Core** - Uses PostStream, Post components, and store API for post management

---

**Made with ❤️ for the Flarum community** 