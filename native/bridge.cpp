#include <windows.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <io.h>
#include <fcntl.h>

namespace {
constexpr DWORD Limit = 1024 * 1024;
std::mutex outputMutex, responseMutex;
std::condition_variable responseAvailable;
std::map<unsigned long long, std::string> responses;
std::atomic<unsigned long long> nextId{1};
std::atomic<bool> stopped{false};

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
bool readExact(HANDLE handle, void* data, DWORD count) {
  auto out = static_cast<char*>(data);
  DWORD received = 0;
  while (count) { if (!ReadFile(handle, out, count, &received, nullptr) || !received) return false; out += received; count -= received; }
  return true;
}
bool writeExact(HANDLE handle, const void* data, DWORD count) {
  auto in = static_cast<const char*>(data);
  DWORD sent = 0;
  while (count) { if (!WriteFile(handle, in, count, &sent, nullptr) || !sent) return false; in += sent; count -= sent; }
  return true;
}
bool frameRead(HANDLE pipe, std::string& value) {
  DWORD length = 0;
  if (!readExact(pipe, &length, sizeof(length)) || !length || length > Limit) return false;
  value.resize(length);
  return readExact(pipe, value.data(), length) && value.find('\0') == std::string::npos;
}
bool frameWrite(HANDLE pipe, const std::string& value) {
  if (value.empty() || value.size() > Limit) return false;
  const DWORD length = static_cast<DWORD>(value.size());
  return writeExact(pipe, &length, sizeof(length)) && writeExact(pipe, value.data(), length);
}
bool singleLine(std::string& json) {
  bool quoted = false, escaped = false;
  for (char& c : json) {
    if (quoted) {
      if (static_cast<unsigned char>(c) < 32) return false;
      if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') quoted = false;
    } else {
      if (c == '"') quoted = true;
      else if (c == '\n' || c == '\r' || c == '\t') c = ' ';
      else if (static_cast<unsigned char>(c) < 32) return false;
    }
  }
  return !quoted;
}
bool getUserSid(std::wstring& sidText) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
  Handle token(raw);
  DWORD needed = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &needed);
  std::vector<BYTE> buffer(needed);
  if (!GetTokenInformation(token.value, TokenUser, buffer.data(), needed, &needed)) return false;
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid)) return false;
  sidText = sid; LocalFree(sid); return true;
}
std::wstring pipePath(const std::wstring& name) {
  if (name.empty() || name.size() > 160 || name.find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-") != std::wstring::npos) return L"";
  return L"\\\\.\\pipe\\" + name;
}
size_t valueEnd(const std::string& json, size_t pos) {
  bool string = false, escaped = false;
  int depth = 0;
  for (size_t cursor = pos; cursor < json.size(); ++cursor) {
    const char c = json[cursor];
    if (string) { if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') string = false; continue; }
    if (c == '"') string = true;
    else if (c == '{' || c == '[') ++depth;
    else if (c == '}' || c == ']') { if (depth == 0) return cursor; --depth; }
    else if (c == ',' && depth == 0) return cursor;
  }
  return json.size();
}
bool responseLine(const std::string& line, unsigned long long& id, std::string& response) {
  if (line.empty() || line.front() != '{') return false;
  size_t cursor = 1; bool hasId = false, hasResponse = false;
  while (cursor < line.size()) {
    cursor = line.find_first_not_of(" \t\r\n,", cursor);
    if (cursor == std::string::npos || line[cursor] == '}') break;
    if (line[cursor] != '"') return false;
    const size_t endKey = line.find('"', cursor + 1);
    if (endKey == std::string::npos) return false;
    const std::string key = line.substr(cursor + 1, endKey - cursor - 1);
    cursor = line.find_first_not_of(" \t\r\n", endKey + 1);
    if (cursor == std::string::npos || line[cursor++] != ':') return false;
    cursor = line.find_first_not_of(" \t\r\n", cursor);
    if (cursor == std::string::npos) return false;
    const size_t endValue = valueEnd(line, cursor);
    if (key == "transportId") { try { id = std::stoull(line.substr(cursor, endValue - cursor)); hasId = true; } catch (...) { return false; } }
    if (key == "response") { response = line.substr(cursor, endValue - cursor); hasResponse = true; }
    cursor = endValue;
  }
  return hasId && hasResponse && response.size() <= Limit;
}
void inputLoop() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.size() > Limit + 100) continue;
    unsigned long long id = 0; std::string response;
    if (!responseLine(line, id, response)) continue;
    { std::lock_guard<std::mutex> lock(responseMutex); responses[id] = response; }
    responseAvailable.notify_all();
  }
  stopped = true;
  responseAvailable.notify_all();
  // Closing the helper also closes its owned process jobs.
  ExitProcess(0);
}
void serveConnection(HANDLE raw) {
  Handle pipe(raw);
  std::string request;
  if (!frameRead(pipe.value, request)) return;
  if (!singleLine(request)) { frameWrite(pipe.value, "{\"ok\":false,\"error\":{\"code\":\"INVALID_JSON\",\"message\":\"Invalid JSON string\"}}"); return; }
  const auto id = nextId.fetch_add(1);
  { std::lock_guard<std::mutex> lock(outputMutex); std::cout << "{\"transportId\":" << id << ",\"request\":" << request << "}" << std::endl; }
  std::unique_lock<std::mutex> lock(responseMutex);
  const bool received = responseAvailable.wait_for(lock, std::chrono::seconds(120), [&] { return responses.count(id) || stopped.load(); });
  const std::string response = received && responses.count(id) ? responses[id] : "{\"ok\":false,\"error\":{\"code\":\"TIMEOUT\",\"message\":\"Platform response timed out\"}}";
  responses.erase(id); lock.unlock();
  frameWrite(pipe.value, response);
  FlushFileBuffers(pipe.value); DisconnectNamedPipe(pipe.value);
}
int server(const std::wstring& name) {
  const std::wstring endpoint = pipePath(name); if (endpoint.empty()) return 2;
  std::wstring sid; if (!getUserSid(sid)) return 3;
  const std::wstring sddl = L"D:P(A;;GA;;;" + sid + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return 4;
  SECURITY_ATTRIBUTES security{ sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
  bool first = true;
  std::thread(inputLoop).detach();
  while (!stopped) {
    HANDLE pipe = CreateNamedPipeW(endpoint.c_str(), PIPE_ACCESS_DUPLEX | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 16, Limit + 4, Limit + 4, 0, &security);
    if (pipe == INVALID_HANDLE_VALUE) { LocalFree(descriptor); return 5; }
    if (first) { std::lock_guard<std::mutex> lock(outputMutex); std::cout << "{\"event\":\"ready\"}" << std::endl; }
    first = false;
    const bool connected = ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED;
    if (connected) std::thread(serveConnection, pipe).detach(); else CloseHandle(pipe);
  }
  LocalFree(descriptor); return 0;
}
int client(const std::wstring& name) {
  const std::wstring endpoint = pipePath(name); if (endpoint.empty()) return 2;
  std::string request; std::getline(std::cin, request); if (request.empty() || request.size() > Limit) return 6;
  if (!WaitNamedPipeW(endpoint.c_str(), 15000)) return 7;
  Handle pipe(CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  if (pipe.value == INVALID_HANDLE_VALUE) return 8;
  if (!frameWrite(pipe.value, request)) return 9;
  std::string response; if (!frameRead(pipe.value, response)) return 10;
  std::cout << response << std::endl; return 0;
}
std::wstring quoteArgument(const std::wstring& arg) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (const wchar_t c : arg) { if (c == L'\\') ++slashes; else { result.append(slashes * (c == L'"' ? 2 : 1), L'\\'); slashes = 0; if (c == L'"') result += L'\\'; result += c; } }
  result.append(slashes * 2, L'\\'); result += L'"'; return result;
}
HANDLE parentProcess() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) return nullptr;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) return nullptr;
  do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return OpenProcess(SYNCHRONIZE, FALSE, entry.th32ParentProcessID);
  } while (Process32NextW(snapshot.value, &entry));
  return nullptr;
}
int job(int argc, wchar_t** argv) {
  if (argc < 3) return 11;
  int start = std::wstring(argv[2]) == L"--" ? 3 : 2; if (start >= argc) return 11;
  Handle owner(parentProcess()); if (!owner.value) return 17;
  Handle ownedJob(CreateJobObjectW(nullptr, nullptr)); if (!ownedJob.value) return 12;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(ownedJob.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 13;
  std::wstring command;
  for (int i = start; i < argc; ++i) { if (!command.empty()) command += L' '; command += quoteArgument(argv[i]); }
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  for (HANDLE h : { startup.hStdInput, startup.hStdOutput, startup.hStdError }) if (h && h != INVALID_HANDLE_VALUE) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(argv[start], command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) return 14;
  Handle child(process.hProcess), thread(process.hThread);
  if (!AssignProcessToJobObject(ownedJob.value, child.value)) { TerminateProcess(child.value, 15); return 15; }
  ResumeThread(thread.value);
  HANDLE waiting[] = { child.value, owner.value };
  const DWORD reason = WaitForMultipleObjects(2, waiting, FALSE, INFINITE);
  if (reason != WAIT_OBJECT_0) {
    TerminateJobObject(ownedJob.value, 16);
    WaitForSingleObject(child.value, INFINITE);
  }
  DWORD exitCode = 1; GetExitCodeProcess(child.value, &exitCode); return static_cast<int>(exitCode);
}
}
int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
  if (argc >= 2 && std::wstring(argv[1]) == L"job") return job(argc, argv);
  if (argc != 4 || std::wstring(argv[2]) != L"--pipe") return 1;
  if (std::wstring(argv[1]) == L"server") return server(argv[3]);
  if (std::wstring(argv[1]) == L"client") return client(argv[3]);
  return 1;
}
