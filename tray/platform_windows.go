//go:build windows

package main

// Windows: the agent runs inside WSL 2 (docs/hosted-control-plane.md §4.7),
// and WSL forwards its 127.0.0.1 port to Windows' own localhost.

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

const platformIconIsICO = true

const (
	createNewConsole = 0x00000010
	createNoWindow   = 0x08000000
	runKey           = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue         = "HomeComputeTray"
)

func openURL(target string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
}

// openLog follows the agent's journal inside WSL in a new console window.
func openLog(file, hint string) error {
	command := exec.Command("wsl.exe", "-e", "journalctl", "-u", "home-compute-agent", "-f")
	if file != "" {
		command = exec.Command("wsl.exe", "-e", "tail", "-n", "200", "-F", file)
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewConsole}
	return command.Start()
}

// The title and body reach the script as environment variables, never as script text.
const toastScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($env:HC_TOAST_TITLE)) > $null
$texts.Item(1).AppendChild($template.CreateTextNode($env:HC_TOAST_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($template))
`

func notify(title, body string) error {
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", toastScript)
	command.Env = append(os.Environ(), "HC_TOAST_TITLE="+title, "HC_TOAST_BODY="+body)
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	return command.Start()
}

func autostartEnabled() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	_, _, err = key.GetStringValue(runValue)
	return err == nil
}

// setAutostart adds or removes this binary under HKCU\...\Run.
func setAutostart(on bool) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if !on {
		err := key.DeleteValue(runValue)
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return key.SetStringValue(runValue, `"`+executable+`"`)
}

func serviceHint() string {
	return "Start it: wsl -u root systemctl start home-compute-agent"
}
