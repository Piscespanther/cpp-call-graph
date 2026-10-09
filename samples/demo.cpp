// 用于验证「调用关系 / 引用关系」的最小工程。
// 把光标放在函数名、宏名、变量上分别试一下四种查询。
#include <cstdio>

// ---- 宏与宏函数：没有「调用层级」，只能走「显示被引用关系」 ----
#define MAX_COUNT 100
#define ADD_ONE(x) ((x) + 1)
#define DOUBLE_AND_ADD(a, b) (ADD_ONE((a) * 2) + (b))
#define LOG_VALUE(v) std::printf("value=%d\n", (v))

int leafAdd(int a, int b) { return a + b; }

// 互相调用：用来验证环检测（↻ 循环引用）
int isEven(int n);
int isOdd(int n);

int isEven(int n) { return n == 0 ? 1 : isOdd(n - 1); }
int isOdd(int n) { return n == 0 ? 0 : isEven(n - 1); }

int compute(int x) {
  int sum = leafAdd(x, ADD_ONE(1));
  if (sum > MAX_COUNT) {
    sum = MAX_COUNT;
  }
  if (isEven(sum)) {
    sum = DOUBLE_AND_ADD(sum, leafAdd(sum, 2));
  }
  return sum;
}

void report(int value) {
  LOG_VALUE(value);
  std::printf("value=%d\n", value);
}

int main() {
  int result = compute(41);
  report(result);
  return 0;
}
