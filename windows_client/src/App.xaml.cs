using System;
using Microsoft.UI.Xaml;

namespace SonicRoom.Windows;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();

        UnhandledException += (_, e) =>
        {
            Diag.Log("UnhandledException", e.Exception);
            // Keep the app alive so a single bad event doesn't kill the whole call.
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Diag.Log("AppDomain.UnhandledException", (e.ExceptionObject as Exception) ?? new Exception(e.ExceptionObject?.ToString()));

        Diag.Log($"app start — log at {Diag.LogPath}");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}
