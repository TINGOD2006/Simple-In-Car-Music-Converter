namespace AudioUsbStudio.Shell.Tests;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        ShellPathsTests.Register();
        PortPickerTests.Register();
        HealthProbeTests.Register();
        EngineHostContractTests.Register();
        EngineHostTests.Register();
        BridgeTests.Register();
        NativeDialogTests.Register();
        UiPanelTests.Register();
        MainFormStateTests.Register();
        return Harness.RunAll();
    }
}
