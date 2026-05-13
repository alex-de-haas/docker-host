namespace Haas.DockerHost.Cli;

public static class CommandLine
{
    public static int Run(string[] args)
    {
        if (args is ["--version"] or ["version"])
        {
            Console.WriteLine(Version);
            return 0;
        }

        Console.WriteLine(HelpText);
        return 0;
    }

    public const string Version = "0.1.0";

    public const string HelpText = """
        docker-host

        Host lifecycle commands will be implemented in the CLI bootstrap phase.

        Planned commands:
          install
          start
          stop
          restart
          update
          status
          logs
          open
          config
        """;
}
