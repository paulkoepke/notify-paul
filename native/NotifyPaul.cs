using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program {
    [STAThread]
    private static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--start") return StartService();
            if (args.Length != 1 || args[0] != "--tray") return 2;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var context = new TrayContext()) Application.Run(context);
            return 0;
        } catch {
            // No exception text: process errors can include environment values.
            WriteStarterLog(Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..")), "Startup failed. Check build and configuration.");
            return 1;
        }
    }

    // Fixed messages only: process errors can include environment values.
    private static void WriteStarterLog(string root, string message) {
        try {
            string file = Path.Combine(root, "logs", "starter.log");
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024) File.WriteAllText(file, "");
            File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + message + "\r\n");
        } catch { }
    }

    // A new start replaces a running instance, so changed configuration always takes effect.
    // Only this repository's service (fixed dist/index.js path) and other copies of this executable are stopped.
    private static void StopPreviousInstance(string root) {
        try {
            string script = Path.Combine(root, "dist", "index.js");
            string self = Process.GetCurrentProcess().MainModule.FileName;
            int ownId = Process.GetCurrentProcess().Id;
            var stopped = new List<Process>();
            using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process WHERE Name = 'node.exe' OR Name = 'NotifyPaul.exe'"))
            foreach (ManagementObject item in searcher.Get()) {
                int id = Convert.ToInt32(item["ProcessId"]);
                if (id == ownId) continue;
                string name = (item["Name"] as string) ?? "";
                string exe = (item["ExecutablePath"] as string) ?? "";
                string command = (item["CommandLine"] as string) ?? "";
                bool service = name.Equals("node.exe", StringComparison.OrdinalIgnoreCase)
                    && command.IndexOf("\"" + script + "\"", StringComparison.OrdinalIgnoreCase) >= 0;
                bool helper = name.Equals("NotifyPaul.exe", StringComparison.OrdinalIgnoreCase)
                    && exe.Equals(self, StringComparison.OrdinalIgnoreCase);
                if (!service && !helper) continue;
                try {
                    Process process = Process.GetProcessById(id);
                    process.Kill();
                    stopped.Add(process);
                } catch { }
            }
            foreach (Process process in stopped) {
                try { process.WaitForExit(5000); } catch { }
            }
            if (stopped.Count > 0) WriteStarterLog(root, "Replaced a running instance.");
        } catch {
            WriteStarterLog(root, "Previous instance could not be checked.");
        }
    }

    private static int StartService() {
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string node = File.ReadAllText(Path.Combine(root, "build", "node-path.txt")).Trim();
        if (!Path.IsPathRooted(node) || !File.Exists(node)) {
            WriteStarterLog(root, "Node.js not found. Run npm run build:native again after changing the Node.js installation.");
            return 1;
        }
        var start = new ProcessStartInfo(node, "\"" + Path.Combine(root, "dist", "index.js") + "\"");
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        start.RedirectStandardError = true;
        start.RedirectStandardOutput = true;
        Process started;
        // Serialize "stop old, start new" so two quick launches cannot stop each other and leave no instance.
        using (var gate = new Mutex(false, "Local\\NotifyPaulStart")) {
            bool locked = false;
            try { locked = gate.WaitOne(15000); } catch (AbandonedMutexException) { locked = true; }
            try {
                StopPreviousInstance(root);
                started = Process.Start(start);
            } finally {
                if (locked) gate.ReleaseMutex();
            }
        }
        // Keep the small launcher alive to drain pipes, including the optional console adapter.
        using (var process = started) {
            process.OutputDataReceived += delegate { };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null) return;
                // Only the service's value-free configuration messages are copied; other stderr stays out of the log.
                if (e.Data.StartsWith("[config] ") && e.Data.Length <= 300) WriteStarterLog(root, e.Data.Substring(9));
                else WriteStarterLog(root, "Service reported an error; check configuration and application log.");
            };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}

public sealed class MenuItemModel { public string id { get; set; } public string text { get; set; } public bool? @checked { get; set; } public bool? enabled { get; set; } }
public sealed class MenuModel { public string tooltip { get; set; } public MenuItemModel[] items { get; set; } }

internal sealed class TrayContext : ApplicationContext {
    private readonly NotifyIcon icon;
    private readonly Control dispatcher = new Control();
    private readonly StreamWriter output;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private bool closing;
    private MenuModel latest;

    internal TrayContext() {
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        dispatcher.CreateControl();
        IntPtr handle = dispatcher.Handle;
        icon = new NotifyIcon();
        icon.Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "notify-paul.ico"));
        icon.Text = "NotifyPaul";
        icon.ContextMenuStrip = BuildMenu(new MenuModel { items = new MenuItemModel[0] });
        icon.Visible = true;
        var thread = new Thread(ReadInput);
        thread.IsBackground = true;
        thread.Start();
    }

    private void Emit(string id) {
        try { output.WriteLine(json.Serialize(new Dictionary<string, string> { { "id", id } })); }
        catch { ExitThread(); }
    }

    private void ReadInput() {
        try {
            using (var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) {
                string line;
                while ((line = input.ReadLine()) != null) {
                    if (line.Length > 16384) continue;
                    MenuModel model = json.Deserialize<MenuModel>(line);
                    dispatcher.BeginInvoke((Action)(() => UpdateMenu(model)));
                }
            }
        } catch { }
        try { dispatcher.BeginInvoke((Action)(() => ExitThread())); } catch { }
    }

    private ContextMenuStrip BuildMenu(MenuModel model) {
        var menu = new ContextMenuStrip();
        foreach (var item in model.items) {
            if (item.id == "separator") { menu.Items.Add(new ToolStripSeparator()); continue; }
            var entry = new ToolStripMenuItem(item.text);
            entry.Checked = item.@checked ?? false;
            entry.Enabled = item.enabled ?? true;
            string id = item.id;
            entry.Click += delegate { Emit(id); };
            menu.Items.Add(entry);
        }
        menu.Opening += delegate { Emit("refresh"); };
        menu.Closed += delegate { if (latest != null) { var next = latest; latest = null; dispatcher.BeginInvoke((Action)(() => UpdateMenu(next))); } };
        return menu;
    }

    private void UpdateMenu(MenuModel model) {
        if (closing || model == null || model.items == null) return;
        icon.Text = model.tooltip ?? "NotifyPaul";
        if (icon.ContextMenuStrip.Visible) {
            // Update checks in place while open; replacing the menu would dismiss it.
            int index = 0;
            foreach (var item in model.items) {
                if (index < icon.ContextMenuStrip.Items.Count) {
                    var entry = icon.ContextMenuStrip.Items[index] as ToolStripMenuItem;
                    if (entry != null) { entry.Checked = item.@checked ?? false; entry.Enabled = item.enabled ?? true; }
                }
                index++;
            }
            latest = model;
            return;
        }
        var previous = icon.ContextMenuStrip;
        icon.ContextMenuStrip = BuildMenu(model);
        previous.Dispose();
    }

    protected override void ExitThreadCore() {
        closing = true;
        icon.Visible = false;
        base.ExitThreadCore();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { closing = true; icon.Visible = false; icon.ContextMenuStrip.Dispose(); icon.Icon.Dispose(); icon.Dispose(); dispatcher.Dispose(); output.Dispose(); }
        base.Dispose(disposing);
    }
}
