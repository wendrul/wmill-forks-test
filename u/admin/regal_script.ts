// doesn't works
import wmill from "windmill-cli@1.542.1";

// works
// import wmill from "windmill-cli@1.541.1";


export async function main() {
  await wmill.parse([
      "workspace",
      "add",
      "test",
      "test",
      process.env["BASE_URL"] + "/",
      "--token",
      process.env["WM_TOKEN"] ?? ""]
    );

}