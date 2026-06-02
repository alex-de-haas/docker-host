using Haas.Hosty.Core;

var builder = WebApplication.CreateBuilder(args);
HostyCoreApplication.ConfigureServices(builder);

var app = builder.Build();
HostyCoreApplication.MapEndpoints(app);

await app.RunAsync();
