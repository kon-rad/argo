/*
 * The .app's real executable.
 *
 * This used to be a bash script, which does not work: when CFBundleExecutable
 * is a script, the process macOS actually runs is /bin/bash, so TCC attributes
 * every file access to bash rather than to SecondBrain.app. The app therefore
 * never earns a TCC identity, never appears under Privacy & Security, and is
 * refused silently. A real Mach-O binary — ad-hoc signed, so its identity is
 * stable across launches — is what gives the grant something to attach to.
 *
 * The vault lives under ~/Documents, which is protected. open() is what makes
 * TCC evaluate access and show the prompt; execv() alone is denied without one.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef SECONDBRAIN_SCRIPT
#define SECONDBRAIN_SCRIPT "/usr/bin/false"
#endif

static void log_to_home_library(void) {
    const char *home = getenv("HOME");
    if (home == NULL) return;

    char path[1024];
    snprintf(path, sizeof(path), "%s/Library/Logs/SecondBrain-launcher.log", home);
    /* ~/Library/Logs is not TCC-protected, so this always lands. A Finder
       launch has nowhere else to print, and a silent failure is undebuggable. */
    freopen(path, "a", stdout);
    freopen(path, "a", stderr);
    setvbuf(stdout, NULL, _IOLBF, 0);
}

static void explain_and_exit(void) {
    fprintf(stderr, "denied access to %s\n", SECONDBRAIN_SCRIPT);
    fflush(stderr);
    system("osascript -e 'display dialog \"Second Brain needs access to your "
           "Documents folder, because the vault lives there.\n\nOpen System "
           "Settings > Privacy & Security > Files and Folders and enable "
           "Documents for SecondBrain. If it is not listed, add SecondBrain to "
           "Full Disk Access with the + button instead.\" buttons {\"OK\"} "
           "default button 1 with title \"Second Brain\" with icon caution' "
           ">/dev/null 2>&1");
    exit(1);
}

int main(int argc, char **argv) {
    log_to_home_library();

    int fd = open(SECONDBRAIN_SCRIPT, O_RDONLY);
    if (fd < 0) {
        if (errno == EPERM || errno == EACCES) explain_and_exit();
        fprintf(stderr, "cannot open %s: %s\n", SECONDBRAIN_SCRIPT, strerror(errno));
        return 1;
    }
    close(fd);

    const char *action = (argc > 1) ? argv[1] : "start";
    execl("/bin/bash", "bash", SECONDBRAIN_SCRIPT, action, (char *)NULL);

    fprintf(stderr, "exec failed: %s\n", strerror(errno));
    return 127;
}
